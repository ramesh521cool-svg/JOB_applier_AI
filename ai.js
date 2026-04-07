const Anthropic = require("@anthropic-ai/sdk");

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  return new Anthropic({ apiKey });
}

// ---------- Score job suitability ----------
async function scoreJob(jobTitle, jobDescription, profile, prefs) {
  const client = getClient();
  const prompt = `You are a career advisor. Score how suitable this job is for the candidate (0-10).

CANDIDATE PROFILE:
Name: ${profile.full_name}
Summary: ${profile.summary}
Resume: ${profile.resume_text?.slice(0, 3000)}

JOB:
Title: ${jobTitle}
Description: ${jobDescription?.slice(0, 2000)}

Respond with JSON only:
{
  "score": <0-10>,
  "reason": "<1-2 sentence explanation>",
  "match_keywords": ["<keyword>"],
  "gap_keywords": ["<missing skill>"]
}`;

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.find(b => b.type === "text")?.text || "{}";
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : text);
  } catch {
    return { score: 5, reason: "Could not parse score", match_keywords: [], gap_keywords: [] };
  }
}

// ---------- Tailor resume ----------
async function tailorResume(jobTitle, jobDescription, profile) {
  const client = getClient();
  const stream = client.messages.stream({
    model: "claude-opus-4-6",
    max_tokens: 3000,
    thinking: { type: "adaptive" },
    system: "You are an expert resume writer. Rewrite the resume to match the job. Keep it truthful. Return ONLY the resume text, no commentary.",
    messages: [{
      role: "user",
      content: `Tailor this resume for the job below. Emphasize relevant skills and experience. Use strong action verbs and metrics.

JOB: ${jobTitle}
DESCRIPTION: ${jobDescription?.slice(0, 2000)}

CURRENT RESUME:
${profile.resume_text?.slice(0, 3000)}

Return the tailored resume text only.`
    }],
  });

  let result = "";
  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
      result += chunk.delta.text;
    }
  }
  return result;
}

// ---------- Generate cover letter ----------
async function generateCoverLetter(jobTitle, company, jobDescription, profile) {
  const client = getClient();
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 800,
    messages: [{
      role: "user",
      content: `Write a professional, concise cover letter (3 paragraphs max).

Candidate: ${profile.full_name}
Job: ${jobTitle} at ${company}
Job Description: ${jobDescription?.slice(0, 1500)}
Resume Summary: ${profile.summary}
Resume: ${profile.resume_text?.slice(0, 1500)}

Return only the cover letter text.`
    }],
  });
  return response.content.find(b => b.type === "text")?.text || "";
}

// ---------- Answer application question ----------
async function answerQuestion(question, jobTitle, company, profile) {
  const client = getClient();
  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `Answer this job application question concisely and professionally.

Question: "${question}"
Job: ${jobTitle} at ${company}
Candidate: ${profile.full_name}
Background: ${profile.summary}
Resume: ${profile.resume_text?.slice(0, 1000)}

Provide a direct, honest answer. If it's a yes/no question, answer yes/no first then explain briefly. Keep under 150 words.`
    }],
  });
  return response.content.find(b => b.type === "text")?.text || "";
}

module.exports = { scoreJob, tailorResume, generateCoverLetter, answerQuestion };
