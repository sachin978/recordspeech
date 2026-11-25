import type { ContextType } from "./types";

// Classify the optional topic so prompts can use the right register.
// Deterministic keyword rules: cheap, instant, testable. The user can also pick a type explicitly.

const RULES: [ContextType, RegExp][] = [
  ["interview", /\b(interview|interviewer|hr round|recruiter|tell me about yourself|job offer|hiring)\b/i],
  [
    "technical",
    /\b(technical|tech|system design|architecture|microservices?|api|apis|database|db|sql|cache|caching|redis|kafka|queue|server|backend|frontend|code|coding|bug|debug|deploy(ment)?|production|latency|scal(e|ing|ability)|algorithm|url shortener|load balancer|kubernetes|docker|cloud|aws|azure|gcp|java|python|javascript|react|node|machine learning|ml|ai|llm|network|protocol|http|tcp|security|encryption|data structure|git)\b/i,
  ],
  [
    "professional",
    /\b(manager|meeting|client|customer|stakeholder|presentation|standup|stand-up|team|colleague|boss|appraisal|performance review|project|deadline|email|office|work|business|sales|negotiat\w*|proposal|report)\b/i,
  ],
  [
    "casual",
    /\b(weekend|holiday|vacation|trip|travel|family|friends?|movie|film|food|cooking|hobby|hobbies|day|morning|evening|game|sports?|cricket|music|book|shopping|festival|party|life)\b/i,
  ],
];

export const CONTEXT_TYPES: ContextType[] = ["technical", "interview", "professional", "casual", "general"];

export function classifyContext(topic: string, explicit?: string | null): ContextType {
  if (explicit && (CONTEXT_TYPES as string[]).includes(explicit) && explicit !== "general") return explicit as ContextType;
  const t = topic.trim();
  if (!t) return "general";
  // An interview about a technical topic is still an interview (register matters most);
  // a technical problem discussed "with my manager" is technical content in a professional setting → technical.
  for (const [type, re] of RULES) if (re.test(t)) return type;
  return "general";
}

/** All registers the topic touches, primary first (e.g. a tech issue with a manager → technical + professional). */
export function matchedContextTypes(topic: string, primary: ContextType): ContextType[] {
  const found = RULES.filter(([, re]) => re.test(topic)).map(([t]) => t);
  return [primary, ...found.filter((t) => t !== primary)].slice(0, 2);
}

export const CONTEXT_GUIDANCE: Record<ContextType, string> = {
  technical:
    "This is a TECHNICAL explanation. Good communication here means: a clear sequence of steps, precise and standard terminology " +
    "(e.g. 'short code', 'mapping', 'cache hit', 'request', 'endpoint'), explicit cause→effect links, and concise sentences. " +
    "Prefer the vocabulary an experienced engineer would use in a design discussion.",
  interview:
    "This is a JOB INTERVIEW answer. Good communication here means: confident, structured answers (situation → what I did → result), " +
    "clear ownership ('I built', 'I led'), professional but warm tone, no rambling. Technical content should still be precise.",
  professional:
    "This is a WORKPLACE conversation (manager, team, client). Good communication here means: polite, clear and direct; " +
    "state the point first, then details; neutral professional vocabulary. Avoid Indian-English office phrases that confuse " +
    "international listeners ('do the needful', 'revert back', 'prepone', 'kindly do') — suggest the international equivalent.",
  casual:
    "This is a CASUAL conversation. Good communication here means: relaxed, natural everyday English with contractions and " +
    "simple words. Do NOT make it formal. Do not provide a professional version unless genuinely useful.",
  general:
    "No specific setting was given. Aim for natural, everyday spoken English. Only offer a professional version when the content is clearly about work.",
};
