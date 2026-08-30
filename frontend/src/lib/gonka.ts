import type { AnomalyReportResult, BatchRecord, ModelVerdict } from './types';
import { analyzeChain, analyzeCrossBatch } from './chainAnalysis';

// ---------------------------------------------------------------------------
// Gonka Router integration.
//
// This calls our own `/api/gonka` (a Vercel function in production, a Vite
// dev-server middleware locally — see `api/gonka.ts` and `vite.config.ts`)
// instead of api.gonkarouter.io directly, for two confirmed-live reasons
// (2026-08-29): api.gonkarouter.io sends no CORS headers, so a browser
// can't call it directly at all; and the API key must never ship inside
// client-bundled code, which any `VITE_`-prefixed env var does. The proxy
// holds the real base URL and key server-side.
//
// Also confirmed live: base auth shape (`Authorization: Bearer <key>`) and
// the OpenAI-style `choices[0].message.content` response envelope are
// correct as written. MiniMax-M2.7 (and likely other reasoning-capable
// models on the router) prepends a `<think>...</think>` block before its
// actual answer — `parseModelJson` strips that before parsing JSON, on top
// of the markdown fences some models also add.
// ---------------------------------------------------------------------------

// Model ID strings aren't secret (unlike the API key/base URL), so these
// stay client-side for the UI to reference by name. Confirmed against
// gonkarouter.io/docs: these are the real model ID strings GonkaRouter
// expects in the "model" field (plain 'minimax'/'kimi' 404s). Note: "model
// ids differ per gateway plan" per their docs — check the /models page for
// your account if these stop working.
const MODEL_A = import.meta.env.VITE_GONKA_MODEL_A || 'MiniMaxAI/MiniMax-M2.7';
const MODEL_B = import.meta.env.VITE_GONKA_MODEL_B || 'moonshotai/Kimi-K2.6';

interface RawModelResponse {
  requestId: string;
  content: string;
}

async function callGonkaModel(model: string, prompt: string): Promise<RawModelResponse> {
  const res = await fetch('/api/gonka', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    // Reasoning-capable models (confirmed live against gonkarouter.io: this
    // is exactly what MiniMax-M2.7 does) prepend a `<think>...</think>`
    // block before the actual answer, on top of the markdown fences some
    // models also add. Strip both, then — since a model can still add
    // stray prose around the object despite the system prompt — fall back
    // to slicing out the outermost `{...}` rather than trusting the string
    // starts/ends exactly at the JSON.
    let cleaned = raw
      .trim()
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

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

function buildCrossBatchPrompt(batches: BatchRecord[], ruleFindings: string[]): string {
  const perBatch = batches
    .map((b) => {
      const timeline =
        b.checkpoints
          .map((c) => `    - [${c.role}] ${c.location} at ${new Date(c.timestampMs).toISOString()} (by ${c.actor})`)
          .join('\n') || '    (no checkpoints)';
      const holdNote = b.isHeld
        ? `CURRENTLY ON HOLD (severity ${b.holdSeverity}, category ${b.holdCategory}): "${b.holdReason}"`
        : `not currently held; ${b.holdHistory.length} past hold(s)`;
      return `Batch ${b.batchCode} (${b.objectId}) — ${holdNote}\n${timeline}`;
    })
    .join('\n\n');

  const findings = ruleFindings.length > 0 ? ruleFindings.map((f) => `- ${f}`).join('\n') : '- none';

  return [
    `Manufacturer address: ${batches[0]?.manufacturer ?? 'unknown'}`,
    `Number of batches from this manufacturer being compared: ${batches.length}`,
    '',
    'Per-batch custody timelines:',
    perBatch,
    '',
    'Automated cross-batch rule findings:',
    findings,
    '',
    'You are looking ACROSS these batches for patterns a single-batch review ' +
      'would miss: the same actor address touching an implausible number of ' +
      'this manufacturer\'s batches, repeated counterfeit findings, clustered ' +
      'timing across supposedly independent batches, or any other sign this ' +
      'manufacturer\'s batches are not independent of each other in a way ' +
      'that suggests systemic rather than one-off counterfeiting. Weigh the ' +
      'rule-based findings but form your own independent judgment.',
  ].join('\n');
}

/**
 * Same two-model, degrade-gracefully pattern as `checkAnomaly`, but reasons
 * over *all* of one manufacturer's batches together instead of one batch in
 * isolation — the kind of pattern (the same actor touching many batches,
 * repeated counterfeit findings) that's invisible to a check scoped to a
 * single batch by construction, not just a matter of the AI trying harder.
 */
export async function checkCrossBatchAnomaly(batches: BatchRecord[]): Promise<AnomalyReportResult> {
  const ruleFindings = analyzeCrossBatch(batches);
  const prompt = buildCrossBatchPrompt(batches, ruleFindings);

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
      console.error(`Gonka Router cross-batch call to ${modelName} failed:`, result.reason);
    }
  });

  if (models.length === 0) {
    return {
      ruleFindings,
      models: [],
      consensus: ruleFindings.length > 0 && batches.length >= 2 ? 'flag' : 'unavailable',
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
