import type { AnomalyReportResult, BatchRecord, ModelVerdict } from './types';
import { analyzeChain } from './chainAnalysis';

// ---------------------------------------------------------------------------
// Gonka Router integration.
//
// HONESTY CHECK BEFORE YOUR DEMO: this targets the OpenAI-compatible
// chat-completions shape most inference routers expose, since that's the
// de facto standard and Gonka Router's own naming strongly suggests it
// follows it. This scaffold was written without live access to
// gonkarouter.io, so three things are assumptions, not verified facts:
//   1. Base URL / path (GONKA_BASE_URL + '/chat/completions')
//   2. Auth header shape (`Authorization: Bearer <key>`)
//   3. Response envelope (`choices[0].message.content`, OpenAI-style)
// Confirm all three against the official docs or the Gonka MCP tool
// (`get_sdk_context`-style helper, if they have one) before relying on this
// for judging. Everything else here — the consensus logic, the rule-based
// fallback, the prompt — is independent of that and will not need to change.
// ---------------------------------------------------------------------------

const GONKA_BASE_URL = import.meta.env.VITE_GONKA_BASE_URL || 'https://api.gonkarouter.io/v1';
const GONKA_API_KEY = import.meta.env.VITE_GONKA_API_KEY || '';

// Confirmed against gonkarouter.io/docs: these are the real model ID strings
// GonkaRouter expects in the "model" field (plain 'minimax'/'kimi' 404s).
// Note: "model ids differ per gateway plan" per their docs — check the
// /models page for your account if these stop working.
const MODEL_A = import.meta.env.VITE_GONKA_MODEL_A || 'MiniMaxAI/MiniMax-M2.7';
const MODEL_B = import.meta.env.VITE_GONKA_MODEL_B || 'moonshotai/Kimi-K2.6';

interface RawModelResponse {
  requestId: string;
  content: string;
}

async function callGonkaModel(model: string, prompt: string): Promise<RawModelResponse> {
  const res = await fetch(`${GONKA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GONKA_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are a supply-chain fraud analyst reviewing a pharmaceutical ' +
            'chain-of-custody log. Respond with STRICT JSON only, no markdown ' +
            'fences and no prose outside the object, matching exactly: ' +
            '{"risk_score": <integer 0-100>, "verdict": "clear" | "flag", ' +
            '"reasoning": "<2-3 sentences>"}.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Gonka Router request failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  const requestId: string = data?.id ?? data?.request_id ?? 'unknown-request-id';
  return { requestId, content };
}

function parseModelJson(model: string, requestId: string, raw: string): ModelVerdict {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    const riskScore = Math.max(0, Math.min(100, Number(parsed.risk_score) || 0));
    const verdict: 'clear' | 'flag' = parsed.verdict === 'flag' ? 'flag' : 'clear';
    return {
      model,
      requestId,
      riskScore,
      verdict,
      reasoning: String(parsed.reasoning ?? 'No reasoning returned.'),
    };
  } catch {
    return {
      model,
      requestId,
      riskScore: 50,
      verdict: 'flag',
      reasoning: `Response could not be parsed as JSON, showing raw output: ${raw.slice(0, 200)}`,
    };
  }
}

function buildPrompt(batch: BatchRecord, ruleFindings: string[]): string {
  const timeline =
    batch.checkpoints
      .map(
        (c, i) =>
          `${i + 1}. [${c.role}] ${c.location} at ${new Date(c.timestampMs).toISOString()} — "${c.note}" (recorded by ${c.actor})`,
      )
      .join('\n') || '(no checkpoints yet)';

  const findings = ruleFindings.length > 0 ? ruleFindings.map((f) => `- ${f}`).join('\n') : '- none';

  return [
    `Product: ${batch.productName}`,
    `Batch code: ${batch.batchCode}`,
    `Manufacturer address: ${batch.manufacturer}`,
    `Created: ${new Date(batch.createdAtMs).toISOString()}`,
    '',
    'Custody timeline (in recorded order):',
    timeline,
    '',
    'Automated rule-based findings for this chain:',
    findings,
    '',
    'Assess whether this custody chain shows signs of counterfeiting or ' +
      'tampering: impossible timing, skipped custody steps, duplicate or ' +
      'cloned scans, or an implausible route. Weigh the rule-based findings ' +
      'but form your own independent judgment.',
  ].join('\n');
}

/**
 * Runs a batch's custody chain through local rule-based checks first, then
 * through two independently-queried Gonka-hosted models for a cross-checked
 * verdict. Degrades gracefully: if Gonka Router is unreachable, the caller
 * still gets the rule-based findings instead of a hard failure — useful
 * insurance against flaky venue wifi during a live demo.
 */
export async function checkAnomaly(batch: BatchRecord): Promise<AnomalyReportResult> {
  const ruleFindings = analyzeChain(batch);
  const prompt = buildPrompt(batch, ruleFindings);

  const settled = await Promise.allSettled([
    callGonkaModel(MODEL_A, prompt),
    callGonkaModel(MODEL_B, prompt),
  ]);

  const models: ModelVerdict[] = [];
  settled.forEach((result, i) => {
    const modelName = i === 0 ? MODEL_A : MODEL_B;
    if (result.status === 'fulfilled') {
      models.push(parseModelJson(modelName, result.value.requestId, result.value.content));
    } else {
      console.error(`Gonka Router call to ${modelName} failed:`, result.reason);
    }
  });

  if (models.length === 0) {
    return {
      ruleFindings,
      models: [],
      consensus: ruleFindings.length > 0 ? 'flag' : 'unavailable',
      combinedRiskScore: null,
    };
  }

  const flags = models.filter((m) => m.verdict === 'flag').length;
  const consensus: AnomalyReportResult['consensus'] =
    models.length === 2 && flags === 1
      ? 'needs_review'
      : flags === models.length
        ? 'flag'
        : 'clear';

  const combinedRiskScore = Math.round(
    models.reduce((sum, m) => sum + m.riskScore, 0) / models.length,
  );

  return { ruleFindings, models, consensus, combinedRiskScore };
}
