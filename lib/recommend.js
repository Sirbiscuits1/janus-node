/**
 * recommend.js — tell a new provider what to run, based on what the market
 * actually wants rather than a name hardcoded by whoever wrote this file.
 *
 * WHY NOT A STATIC TABLE
 * ----------------------
 * A list of "good models for 12 GB" baked into source is wrong within months:
 * new releases land, names change, and the author's favourites are not the
 * market's. Worse, it tells everyone to run the same thing, which is the one
 * outcome that earns nobody anything.
 *
 * So the primary signal is the overlay itself. Every model name in the index is
 * live by definition, and the index also says how many people already offer it
 * and what they charge. That gives the two things that actually decide earnings:
 *
 *   value   — what buyers pay for an answer from this model
 *   scarcity — how many others are already selling it
 *
 * A card that can run something valuable AND under-served should be told so.
 * Being the fourth provider of the cheapest model on the board is not a living.
 *
 * The static table exists only for a cold start, when the index is empty or
 * unreachable, and it is deliberately tiny.
 */

/** Rough VRAM needed to serve a model at a 4-bit quantization, in GB.
 *  ~0.6 GB per billion parameters for weights, plus room for the KV cache. */
export const vramNeededGb = (billionParams) => {
  if (!Number.isFinite(billionParams) || billionParams <= 0) return null
  return Math.ceil(billionParams * 0.6 * 1.25)
}

/** Parameter count from a model id: "Llama-3.1-8B-Instruct" -> 8 */
export const paramsOf = (name) => {
  const m = String(name).match(/(\d+(?:\.\d+)?)\s*b\b/i)
  return m ? Number(m[1]) : null
}

/**
 * Best-effort Ollama tag for a model id seen in the index. Deliberately
 * conservative: when we are not confident, we say where to look rather than
 * inventing a tag that fails on `ollama pull`.
 */
export const ollamaTagFor = (modelId) => {
  const id = String(modelId).toLowerCase()
  const p = paramsOf(modelId)
  const size = p ? `${p}b` : null

  const family =
    id.includes('llama-3.3') || id.includes('llama3.3') ? 'llama3.3'
      : id.includes('llama-3.2') || id.includes('llama3.2') ? 'llama3.2'
        : id.includes('llama-3.1') || id.includes('llama3.1') ? 'llama3.1'
          : id.includes('mistral-nemo') || id.includes('nemo') ? 'mistral-nemo'
            : id.includes('mistral') ? 'mistral'
              : id.includes('qwen') ? 'qwen'
                : id.includes('gemma') ? 'gemma'
                  : id.includes('phi') ? 'phi'
                    : null

  if (!family) return { tag: null, search: 'https://ollama.com/library' }

  // mistral-nemo has one size, so a tag suffix would be wrong.
  if (family === 'mistral-nemo') return { tag: 'mistral-nemo', search: null }

  // Qwen major versions move fast enough that guessing a tag is a bad bet.
  if (family === 'qwen') {
    return { tag: null, search: 'https://ollama.com/library/qwen2.5' }
  }

  if (!size) return { tag: null, search: `https://ollama.com/library/${family}` }
  return { tag: `${family}:${size}`, search: null }
}

/** Cold start only: used when the overlay returns nothing to learn from. */
export const FALLBACK_BY_VRAM = [
  { maxVram: 6, tag: 'llama3.2:3b', label: 'Llama 3.2 3B', downloadGb: 2 },
  { maxVram: 10, tag: 'llama3.1:8b', label: 'Llama 3.1 8B', downloadGb: 4.7 },
  { maxVram: 16, tag: 'mistral-nemo', label: 'Mistral Nemo 12B', downloadGb: 7 },
  { maxVram: Infinity, tag: 'llama3.1:8b', label: 'Llama 3.1 8B', downloadGb: 4.7 }
]

/**
 * Rank what this machine could run, by what it would earn.
 *
 * @param {Array}  listings  from the overlay: { model, satsPerMOutput, providerKey }
 * @param {number} vramGb    what this machine has to spend
 * @param {Array}  installed Ollama models already downloaded, so we can mark them
 */
export const rankOpportunities = (listings, vramGb, installed = []) => {
  const installedNames = new Set(installed.map((m) => String(m.name).toLowerCase()))

  // Collapse the index into one row per model, carrying how contested it is.
  const byModel = new Map()
  for (const l of listings) {
    const key = l.model
    const row = byModel.get(key) ?? { model: key, prices: [], providers: new Set() }
    row.prices.push(l.satsPerMOutput)
    if (l.providerKey) row.providers.add(l.providerKey)
    byModel.set(key, row)
  }

  const out = []
  for (const row of byModel.values()) {
    const params = paramsOf(row.model)
    const needed = vramNeededGb(params)
    // A model we cannot size is a model we cannot promise to run.
    if (needed === null) continue
    if (needed > vramGb) continue

    const price = Math.min(...row.prices)
    const competitors = row.providers.size

    // Earnings potential: what an answer pays, discounted by how many people
    // are already selling it. The +1 avoids dividing by zero and correctly makes
    // a model nobody offers the most attractive thing on the board.
    const score = price / (competitors + 1)

    const { tag, search } = ollamaTagFor(row.model)

    out.push({
      model: row.model,
      params,
      vramNeededGb: needed,
      satsPerMOutput: price,
      competitors,
      score,
      ollamaTag: tag,
      searchUrl: search,
      alreadyInstalled: tag ? installedNames.has(tag) : false,
      // Why this is being suggested, in words the person can act on.
      reason: competitors === 0
        ? 'nobody is offering this yet'
        : competitors === 1
          ? 'only one other provider'
          : `${competitors} providers already`
    })
  }

  return out.sort((a, b) => b.score - a.score)
}

/**
 * The single recommendation to show, plus the runners-up.
 *
 * Prefers something already downloaded when it is close in value, because a
 * provider who can start in thirty seconds is worth more than one who might
 * come back after a 40 GB download, and might not.
 */
export const recommend = ({ listings, vramGb, installed = [] }) => {
  const ranked = rankOpportunities(listings, vramGb, installed)

  if (ranked.length === 0) {
    const fb = FALLBACK_BY_VRAM.find((f) => vramGb <= f.maxVram) ?? FALLBACK_BY_VRAM.at(-1)
    return {
      source: 'fallback',
      best: {
        model: fb.label,
        ollamaTag: fb.tag,
        downloadGb: fb.downloadGb,
        reason: 'nothing comparable listed yet — this is a safe first model',
        alreadyInstalled: false
      },
      alternatives: []
    }
  }

  const top = ranked[0]
  const readyNow = ranked.find((r) => r.alreadyInstalled)

  // Take the installed one unless the best is meaningfully more valuable.
  const best = (readyNow && readyNow.score >= top.score * 0.6) ? readyNow : top

  return {
    source: 'market',
    best,
    alternatives: ranked.filter((r) => r.model !== best.model).slice(0, 3)
  }
}
