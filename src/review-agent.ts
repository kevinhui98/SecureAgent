import OpenAI from 'openai';
import { PR_SUGGESTION_TEMPLATE, buildPatchPrompt, constructPrompt, getReviewPrompt, getTokenLength, getXMLReviewPrompt, isConversationWithinLimit } from './prompts';
import { BranchDetails, BuilderResponse, Builders, ChatMessage, CodeSuggestion, LLModel, PRFile, PRSuggestion } from './constants';
import { PullRequestEvent, WebhookEventMap } from '@octokit/webhooks-definitions/schema';
import { axiom } from './logger';
import { Octokit } from '@octokit/rest';
import { getGitFile } from './reviews';
import * as crypto from 'crypto';
import * as xml2js from "xml2js";
import { INLINE_FN, getInlineFixPrompt } from './prompts/inline-prompt';
import { chatFns } from './llms/chat';
import { PRSuggestionImpl } from './data/PRSuggestionImpl';

interface PRLogEvent {
    id: number;
    fullName: string;
    url: string;
};

export const logPRInfo = (pullRequest: PullRequestEvent) => {
    const logEvent: PRLogEvent = {
        id: pullRequest.repository.id,
        fullName: pullRequest.repository.full_name,
        url: pullRequest.repository.html_url,
    }
    axiom.ingest('review-agent', [logEvent]);
    return logEvent;
}

export const reviewDiff = async (traceTag: string, convo: ChatMessage[], model: LLModel = "gpt-3.5-turbo") => {
    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });
    const requestParams = {  
        messages: convo,
        model: model,
        temperature: 0
    };
    try {
        //@ts-ignore
        const chatCompletion = await openai.chat.completions.create(requestParams);
        return chatCompletion.choices[0].message.content;
    } catch (exc) {
        throw new Error("Error getting LLM response")
    }
    
}

export const reviewFiles = async (traceTag: string, files: PRFile[], model: LLModel, patchBuilder: (file: PRFile) => string, convoBuilder: (diff: string) => ChatMessage[]) => {
    const patches = files.map((file) => patchBuilder(file));
    const convo = convoBuilder(patches.join("\n"));
    const feedback = await reviewDiff(traceTag, convo, model);
    return feedback
}

const filterFile = (file: PRFile) => {
    const extensionsToIgnore = new Set<string>(["pdf", "png", "jpg", "jpeg", "gif", "mp4", "mp3", "md", "json", "env", "toml", "svg"])
    const filesToIgnore = new Set<string>(["package-lock.json", "yarn.lock", ".gitignore", "package.json", "tsconfig.json", "poetry.lock", "readme.md"]);
    const filename = file.filename.toLowerCase().split('/').pop();
    if (filename && filesToIgnore.has(filename)) {
        return false;
    }
    const splitFilename = file.filename.toLowerCase().split('.');
    if (splitFilename.length <= 1) {
        return false; // return false if there is no extension
    }
    const extension = splitFilename.pop()?.toLowerCase();
    if (extension && extensionsToIgnore.has(extension)) {
        return false;
    }
    return true;
}

const groupFilesByExtension = (files: PRFile[]): Map<string, PRFile[]> => {
    const filesByExtension: Map<string, PRFile[]> = new Map();

    files.forEach((file) => {
        const extension = file.filename.split('.').pop()?.toLowerCase();
        if (extension) {
            if (!filesByExtension.has(extension)) {
                filesByExtension.set(extension, []);
            }
            filesByExtension.get(extension)?.push(file);
        }
    });

    return filesByExtension;
}


// all of the files here can be processed with the prompt at minimum
const processWithinLimitFiles = (files: PRFile[], model: LLModel, patchBuilder: (file: PRFile) => string, convoBuilder: (diff: string) => ChatMessage[]) => {
    const processGroups: PRFile[][] = [];
    const convoWithinModelLimit = isConversationWithinLimit(constructPrompt(files, patchBuilder, convoBuilder), model);

    console.log(`Within model token limits: ${convoWithinModelLimit}`);
    if (!convoWithinModelLimit) {
        const grouped = groupFilesByExtension(files);
        for (const [extension, filesForExt] of grouped.entries()) {
            const extGroupWithinModelLimit = isConversationWithinLimit(constructPrompt(filesForExt, patchBuilder, convoBuilder), model);
            if (extGroupWithinModelLimit) {
                processGroups.push(filesForExt);
            } else { // extension group exceeds model limit
                console.log('Processing files per extension that exceed model limit ...');
                let currentGroup: PRFile[] = [];
                filesForExt.sort((a, b) => a.patchTokenLength - b.patchTokenLength);
                filesForExt.forEach(file => {
                    const isPotentialGroupWithinLimit = isConversationWithinLimit(constructPrompt([...currentGroup, file], patchBuilder, convoBuilder), model);
                    if (isPotentialGroupWithinLimit) {
                        currentGroup.push(file);
                    } else {
                        processGroups.push(currentGroup);
                        currentGroup = [file];
                    }
                });
                if (currentGroup.length > 0) {
                    processGroups.push(currentGroup);
                }
            }
        }
    } else {
        processGroups.push(files);
    }
    return processGroups;
}

const stripRemovedLines = (originalFile: PRFile) => {
    // remove lines starting with a '-'
    const originalPatch = String.raw`${originalFile.patch}`;
    const strippedPatch = originalPatch.split('\n').filter(line => !line.startsWith('-')).join('\n');
    return { ...originalFile, patch: strippedPatch };
}

const processOutsideLimitFiles = (files: PRFile[], model: LLModel, patchBuilder: (file: PRFile) => string, convoBuilder: (diff: string) => ChatMessage[]) => {
    const processGroups: PRFile[][] = [];
    if (files.length == 0) {
        return processGroups;
    }
    files = files.map((file) => stripRemovedLines(file));
    const convoWithinModelLimit = isConversationWithinLimit(constructPrompt(files, patchBuilder, convoBuilder), model);
    if (convoWithinModelLimit) {
        processGroups.push(files);
    } else {
        const exceedingLimits: PRFile[] = [];
        const withinLimits: PRFile[] = [];
        files.forEach((file) => {
            const isFileConvoWithinLimits = isConversationWithinLimit(constructPrompt([file], patchBuilder, convoBuilder), model);
            if (isFileConvoWithinLimits) {
                withinLimits.push(file);
            } else {
                exceedingLimits.push(file);
            }
        });
        const withinLimitsGroup = processWithinLimitFiles(withinLimits, model, patchBuilder, convoBuilder);
        withinLimitsGroup.forEach((group) => {
            processGroups.push(group);
        });
        if (exceedingLimits.length > 0) {
            console.log("TODO: Need to further chunk large file changes.");
            // throw "Unimplemented"
        }
    }
    return processGroups;
}

const processXMLSuggestions = async (feedbacks: string[]) => {
    const xmlParser = new xml2js.Parser();
    const parsedSuggestions = await Promise.all(
        feedbacks.map((fb) => {
            fb = fb.split('<code>').join('<code><![CDATA[').split('</code>').join(']]></code>');
            console.log(fb)
            return xmlParser.parseStringPromise(fb);
        })
    );
    // gets suggestion arrays [[suggestion], [suggestion]], then flattens
    const allSuggestions = parsedSuggestions.map((sug) => sug.review.suggestion).flat(1)
    const suggestions: PRSuggestion[] = allSuggestions.map(rawSuggestion => {
        const lines = rawSuggestion.code[0].trim().split("\n")
        lines[0] = lines[0].trim()
        lines[lines.length-1] = lines[lines.length-1].trim()
        const code = lines.join("\n")

        return new PRSuggestionImpl(rawSuggestion.describe[0], rawSuggestion.type[0], rawSuggestion.comment[0], code, rawSuggestion.filename[0]);
    });
    return suggestions;
}

const generateGithubIssueUrl = (owner: string, repoName: string, title: string, body: string, codeblock?: string) => {
    const encodedTitle = encodeURIComponent(title);
    const encodedBody = encodeURIComponent(body);
    const encodedCodeBlock = codeblock ? encodeURIComponent(`\n${codeblock}\n`) : '';

    let url = `https://github.com/${owner}/${repoName}/issues/new?title=${encodedTitle}&body=${encodedBody}${encodedCodeBlock}`;

    if (url.length > 2048) {
        url = `https://github.com/${owner}/${repoName}/issues/new?title=${encodedTitle}&body=${encodedBody}`;
    }
    return `[Create Issue](${url})`;
}

export const dedupSuggestions = (suggestions: PRSuggestion[]): PRSuggestion[] => {
    const suggestionsMap = new Map<string, PRSuggestion>();
    suggestions.forEach(suggestion => {
        suggestionsMap.set(suggestion.identity(), suggestion);
    });
    return Array.from(suggestionsMap.values());
}

const convertPRSuggestionToComment = (owner: string, repo: string, suggestions: PRSuggestion[]): string[] => {
    const suggestionsMap = new Map<string, PRSuggestion[]>();
    suggestions.forEach((suggestion) => {
        if (!suggestionsMap.has(suggestion.filename)) {
            suggestionsMap.set(suggestion.filename, []);
        }
        suggestionsMap.get(suggestion.filename).push(suggestion);
    });
    const comments: string[] = [];
    for (let [filename, suggestions] of suggestionsMap) {
        const temp = [`## ${filename}\n`];
        suggestions.forEach((suggestion: PRSuggestion) => {
            const issueLink = generateGithubIssueUrl(owner, repo, suggestion.describe, suggestion.comment, suggestion.code);
            temp.push(
                PR_SUGGESTION_TEMPLATE.replace("{COMMENT}", suggestion.comment).replace("{CODE}", suggestion.code).replace("{ISSUE_LINK}", issueLink)
            );
        });
        comments.push(temp.join("\n"));
    }
    return comments;
}

const xmlResponseBuilder = async (owner: string, repoName: string, feedbacks: string[]): Promise<BuilderResponse> => {
    console.log("IN XML RESPONSE BUILDER");
    const parsedXMLSuggestions = await processXMLSuggestions(feedbacks);
    const comments = convertPRSuggestionToComment(owner, repoName, dedupSuggestions(parsedXMLSuggestions));
    const commentBlob = comments.join("\n")
    return { comment: commentBlob, structuredComments: parsedXMLSuggestions }
}

const curriedXmlResponseBuilder = (owner: string, repoName: string) => {
    return (feedbacks: string[]) => xmlResponseBuilder(owner, repoName, feedbacks);
}


const basicResponseBuilder = async (feedbacks: string[]): Promise<BuilderResponse> => {
    console.log("IN BASIC RESPONSE BUILDER");
    const commentBlob = feedbacks.join("\n");
    return { comment: commentBlob, structuredComments: [] }
}

export const reviewChanges = async (traceTag: string, files: PRFile[], convoBuilder: (diff: string) => ChatMessage[], responseBuilder: (responses: string[]) => Promise<BuilderResponse>, model: LLModel = "gpt-3.5-turbo") => {
    const patchBuilder = buildPatchPrompt;
    const filteredFiles = files.filter((file) => filterFile(file));
    filteredFiles.map((file) => {
        file.patchTokenLength = getTokenLength(patchBuilder(file));
    });
    // further subdivide if necessary, maybe group files by common extension?
    const patchesWithinModelLimit: PRFile[] = [];
    // these single file patches are larger than the full model context
    const patchesOutsideModelLimit: PRFile[] = [];
    
    filteredFiles.forEach((file) => {
        const patchWithPromptWithinLimit = isConversationWithinLimit(constructPrompt([file], patchBuilder, convoBuilder), model);
        if (patchWithPromptWithinLimit) {
            patchesWithinModelLimit.push(file);
        } else {
            patchesOutsideModelLimit.push(file);
        }
    });

    console.log(`files within limits: ${patchesWithinModelLimit.length}`);
    const withinLimitsPatchGroups = processWithinLimitFiles(patchesWithinModelLimit, model, patchBuilder, convoBuilder);
    const exceedingLimitsPatchGroups = processOutsideLimitFiles(patchesOutsideModelLimit, model, patchBuilder, convoBuilder);
    console.log(`${withinLimitsPatchGroups.length} within limits groups.`)
    console.log(`${patchesOutsideModelLimit.length} files outside limit, skipping them.`)

    const groups = [...withinLimitsPatchGroups, ...exceedingLimitsPatchGroups];

    const feedbacks = await Promise.all(
        groups.map((patchGroup) => {
            return reviewFiles(traceTag, patchGroup, model, patchBuilder, convoBuilder);
        })
    );
    try {
        return await responseBuilder(feedbacks);
    } catch (exc) {
        console.log("XML parsing error");
        console.log(exc);
        throw exc;
    }
}

const indentCodeFix = (file: string, code: string, lineStart: number): string => {
    const fileLines = file.split("\n");
    const firstLine = fileLines[lineStart-1];
    const codeLines = code.split("\n");
    const indentation = firstLine.match(/^(\s*)/)[0];
    const indentedCodeLines = codeLines.map(line => indentation + line);
    return indentedCodeLines.join("\n");
}

const isCodeSuggestionNew = (contents: string, suggestion: CodeSuggestion): boolean => {
    const fileLines = contents.split("\n");
    const targetLines = fileLines.slice(suggestion.line_start - 1, suggestion.line_end).join("\n");
    if (targetLines.trim() == suggestion.correction.trim()) { // same as existing code.
        return false;
    }
    return true;
}

export const generateInlineComments = async (traceTag: string, suggestion: PRSuggestion, file: PRFile, model: LLModel = "gpt-3.5-turbo"): Promise<CodeSuggestion> => {
    try {
        const convo = getInlineFixPrompt(file.current_contents, suggestion);
        const fnResponse = await chatFns(traceTag, crypto.randomUUID(), convo, INLINE_FN, {"function_call": {"name": "fix"}});
        const args = JSON.parse(fnResponse.choices[0].message.function_call.arguments);
        const initialCode = String.raw`${args["code"]}`;
        const indentedCode = indentCodeFix(file.current_contents, initialCode, args["lineStart"]);
        const codeFix = {
            file: suggestion.filename,
            line_start: args["lineStart"],
            line_end: args["lineEnd"],
            correction: indentedCode,
            comment: args["comment"]
        }
        if (isCodeSuggestionNew(file.current_contents, codeFix)) {
            return codeFix;
        }
        return null;
    } catch (exc) {
        console.log(exc);
        return null;
    }
}


const preprocessFile = async (octokit: Octokit, payload: WebhookEventMap["pull_request"], file: PRFile) => {
    const { base, head } = payload.pull_request;
    const baseBranch: BranchDetails = {
        name: base.ref,
        sha: base.sha,
        url: payload.pull_request.url
    };
    const currentBranch: BranchDetails = {
        name: head.ref,
        sha: head.sha,
        url: payload.pull_request.url
    };
    // Handle scenario where file does not exist!!
    const [oldContents, currentContents] = await Promise.all([
        getGitFile(octokit, payload, baseBranch, file.filename),
        getGitFile(octokit, payload, currentBranch, file.filename)
    ]);

    if (oldContents.content != null) {
        file.old_contents = String.raw`${oldContents.content}`;
    } else {
        file.old_contents = null;
    }

    if (currentContents.content != null) {
        file.current_contents = String.raw`${currentContents.content}`;
    } else {
        file.current_contents = null;
    }
}

const reviewChangesRetry = async (traceTag: string, files: PRFile[], builders: Builders[], model: LLModel = "gpt-3.5-turbo") => {
    for (const {convoBuilder, responseBuilder} of builders) {
        try {
            console.log(`Trying with convoBuilder: ${convoBuilder.name}.`);
            return await reviewChanges(traceTag, files, convoBuilder, responseBuilder, model);
        } catch (error) {
            console.log(`Error with convoBuilder: ${convoBuilder.name}, trying next one. Error: ${error}`);
        }
    }
    throw new Error('All convoBuilders failed.');
}

export const processPullRequest = async (octokit: Octokit, payload: WebhookEventMap["pull_request"], files: PRFile[], model: LLModel = "gpt-3.5-turbo", includeSuggestions = false) => {
    const reviewTraceTag = `${payload.pull_request.id}-review`;
    const inlineTraceTag = `${payload.pull_request.id}-inline`
    const filteredFiles = files.filter((file) => filterFile(file));
    if (filteredFiles.length == 0) {
        console.log("nothing to comment on")
        return {
            review: null,
            suggestions: []
        }
    }
    await Promise.all(filteredFiles.map((file) => {
        return preprocessFile(octokit, payload, file)
    }));
    const owner = payload.repository.owner.login;
    const repoName = payload.repository.name;
    const curriedXMLResponseBuilder = curriedXmlResponseBuilder(owner, repoName);
    if (includeSuggestions) {
        const reviewComments = await reviewChangesRetry(reviewTraceTag, filteredFiles, [
                {convoBuilder: getXMLReviewPrompt, responseBuilder: curriedXMLResponseBuilder},
                {convoBuilder: getReviewPrompt, responseBuilder: basicResponseBuilder}
            ], model);
        let inlineComments: CodeSuggestion[] = [];
        if (reviewComments.structuredComments.length > 0) {
            console.log("STARTING INLINE COMMENT PROCESSING");
            inlineComments = await Promise.all(
                reviewComments.structuredComments.map((suggestion) => {
                    // find relevant file
                    const file = files.find(file => file.filename === suggestion.filename);
                    if (file == null) {
                        return null;
                    }
                    return generateInlineComments(inlineTraceTag, suggestion, file, model);
                })
            );
        }
        const filteredInlineComments = inlineComments.filter(comment => comment !== null);
        return {
            review: reviewComments,
            suggestions: filteredInlineComments
        }
    } else {
        const [review] = await Promise.all([
            reviewChangesRetry(reviewTraceTag, filteredFiles, [
                {convoBuilder: getXMLReviewPrompt, responseBuilder: curriedXMLResponseBuilder},
                {convoBuilder: getReviewPrompt, responseBuilder: basicResponseBuilder}
            ], model),
        ]);

        return {
            review,
            suggestions: []
        };
    }
}