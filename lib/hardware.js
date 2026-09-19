/**
 * hardware.js — work out what this machine can actually sell.
 *
 * The person running this may not know what a GPU is, let alone how much VRAM it
 * has or which models fit in it. So nothing here asks. We look.
 *
 * Deliberately: we only ever recommend models the user ALREADY has pulled in
 * Ollama. Suggesting a model they don't have turns a one-click setup into a
 * 40GB download they didn't agree to, on a connection we know nothing about.
 * If they have nothing suitable we say so plainly and name one small download.
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'

const run = promisify(exec)

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

/** Ollama's OpenAI-compatible base. This is what the provider will call. */
export const ollamaOpenAIBase = (base = DEFAULT_OLLAMA_URL) =>
  `${base.replace(/\/+$/, '')}/v1`

const tryRun = async (cmd) => {
  try {
    const { stdout } = await run(cmd, { timeout: 8000, windowsHide: true })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * NVIDIA first, because it is the common case and nvidia-smi is reliable.
 * Apple Silicon second, where "VRAM" is unified memory and we take a
 * conservative slice of total RAM, since the OS needs the rest.
 */
export const detectGpu = async () => {
  const smi = await tryRun('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits')
  if (smi) {
    const rows = smi.split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((r) => r.length >= 2)
    if (rows.length > 0) {
      const gpus = rows.map(([name, mib]) => ({ name, vramGb: Math.round(Number(mib) / 1024) }))
      const total = gpus.reduce((sum, g) => sum + (Number.isFinite(g.vramGb) ? g.vramGb : 0), 0)
      return {
        kind: 'nvidia',
        gpus,
        label: gpus.length === 1 ? gpus[0].name : `${gpus.length}× ${gpus[0].name}`,
        vramGb: total
      }
    }
  }

  if (process.platform === 'darwin') {
    const chip = await tryRun('sysctl -n machdep.cpu.brand_string')
    const isAppleSilicon = process.arch === 'arm64'
    if (isAppleSilicon) {
      const totalGb = Math.round(os.totalmem() / 1024 ** 3)
      return {
        kind: 'apple',
        gpus: [{ name: chip || 'Apple Silicon', vramGb: totalGb }],
        label: chip || 'Apple Silicon',
        // Unified memory: the OS and everything else live here too. Claiming all
        // of it would recommend a model that swaps and times out under load.
        vramGb: Math.max(4, Math.floor(totalGb * 0.6))
      }
    }
  }

  return {
    kind: 'unknown',
    gpus: [],
    label: 'No GPU detected',
    vramGb: 0
  }
}

/** Is Ollama running, and what has this person already downloaded? */
export const detectOllama = async (base = DEFAULT_OLLAMA_URL) => {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) return { running: false, models: [] }
    const json = await res.json()
    const models = (json?.models ?? []).map((m) => ({
      name: m.name,
      sizeGb: m.size ? Number((m.size / 1024 ** 3).toFixed(1)) : null,
      family: m.details?.family ?? null,
      parameterSize: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null
    }))
    return { running: true, models }
  } catch {
    return { running: false, models: [] }
  }
}

/**
 * Map Ollama's quantization strings onto the values ComputeTopicManager admits.
 * Anything we cannot map confidently becomes 'unknown', which is honest and
 * still publishes.
 */
export const mapQuantization = (raw) => {
  if (!raw) return 'unknown'
  const q = String(raw).toUpperCase()
  if (q.includes('F32') || q.includes('FP32')) return 'fp32'
  if (q.includes('BF16')) return 'bf16'
  if (q.includes('F16') || q.includes('FP16')) return 'fp16'
  if (q.includes('FP8') || q.includes('F8')) return 'fp8'
  if (q.includes('Q8') || q.includes('INT8')) return 'int8'
  if (q.includes('Q4') || q.includes('Q5') || q.includes('Q6') || q.includes('INT4')) return 'int4'
  return 'unknown'
}

/**
 * A model is servable if it fits in VRAM with headroom for the context window.
 * The 1.25 factor is deliberately generous: a model that only just fits will
 * produce timeouts under load, and a provider whose first ten requests time out
 * is worse for the marketplace than one that never listed.
 */
export const fitsInVram = (modelSizeGb, vramGb) => {
  if (!Number.isFinite(modelSizeGb) || !Number.isFinite(vramGb) || vramGb <= 0) return false
  return (modelSizeGb * 1.25) <= vramGb
}

/**
 * Pick the best model this machine can serve: the largest that comfortably fits,
 * because bigger models earn more per token and the whole point is to use
 * hardware that is otherwise idle.
 */
export const recommendModel = (ollamaModels, vramGb) => {
  const candidates = ollamaModels
    .filter((m) => m.sizeGb !== null && fitsInVram(m.sizeGb, vramGb))
    .sort((a, b) => b.sizeGb - a.sizeGb)

  return candidates[0] ?? null
}

/** One call: everything the setup wizard needs to decide without asking. */
export const inspectMachine = async ({ ollamaUrl = DEFAULT_OLLAMA_URL } = {}) => {
  const [gpu, ollama] = await Promise.all([detectGpu(), detectOllama(ollamaUrl)])

  // No GPU is not fatal. A big CPU box can serve a 3B model perfectly well; it
  // is just slow, and the market can price that.
  const effectiveVram = gpu.vramGb > 0
    ? gpu.vramGb
    : Math.max(2, Math.floor((os.totalmem() / 1024 ** 3) * 0.4))

  const recommended = ollama.running ? recommendModel(ollama.models, effectiveVram) : null

  return {
    gpu,
    ollama,
    effectiveVram,
    recommended,
    // Everything the wizard must be able to explain in one sentence each.
    problems: [
      ...(ollama.running ? [] : ['Ollama is not running']),
      ...(ollama.running && ollama.models.length === 0 ? ['Ollama has no models downloaded'] : []),
      ...(ollama.running && ollama.models.length > 0 && !recommended
        ? ['None of the downloaded models fit comfortably in this machine']
        : [])
    ]
  }
}
