import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];
  const promptAdjustment = core.getInput("prompt_adjustment");

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files

    // Consolidate all chunks for this file into a single prompt
    const prompt = createPromptForFile(file, prDetails, promptAdjustment);
    const aiResponse = await getAIResponse(prompt);
    if (aiResponse) {
      const newComments = createCommentsFromResponse(file, aiResponse);
      if (newComments) {
        comments.push(...newComments);
      }
    }
  }
  return comments;
}

function createPromptForFile(
  file: File,
  prDetails: PRDetails,
  promptAdjustment = ""
): string {
  // Combine all chunks into a single diff representation
  const chunksContent = file.chunks
    .map((chunk) => {
      return `${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}`;
    })
    .join("\n\n");

  return `Your task is to review code diffs. Instructions:
- Provide the response in JSON format: {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>"}]}
- Do not give compliments.
- Only provide comments and suggestions if there is something to improve; otherwise, "reviews" should be an empty array.
- Write in GitHub Markdown format.
- IMPORTANT: NEVER suggest adding comments to the code.

${promptAdjustment}

Review the following code diff in file "${file.to}" and consider the pull request context.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunksContent}
\`\`\`
`;
}

function modelSupportsJsonResponse(model: string): boolean {
  const supportedModels = ["gpt-4o", "gpt-4.5-preview", "o3-mini", "o1"];
  return supportedModels.includes(model);
}

function getQueryConfig() {
  const queryConfig: any = {
    model: OPENAI_API_MODEL,
  };

  if (OPENAI_API_MODEL.startsWith("gpt-4")) {
    queryConfig.temperature = 0.2;
    queryConfig.frequency_penalty = 0.2;
    queryConfig.presence_penalty = 0;
  }

  const maxTokens = 5000;
  if (OPENAI_API_MODEL === "gpt-4") {
    queryConfig.max_tokens = maxTokens;
  } else {
    queryConfig.max_completion_tokens = maxTokens;
  }

  return queryConfig;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = getQueryConfig();

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(modelSupportsJsonResponse(OPENAI_API_MODEL)
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createCommentsFromResponse(
  file: File,
  aiResponses: Array<{ lineNumber: string; reviewComment: string }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
