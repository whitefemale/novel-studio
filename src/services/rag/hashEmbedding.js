import { fnv1a32 } from '../novel/snapshot.js'

/**
 * 纯 JS 的「哈希向量」：把一段中文文本变成 256 维稀疏计数向量。
 *
 * 这不是语义模型 —— 它只看字面（单字、双字 n-gram、拉丁词），没有训练、
 * 没有随机数、没有网络、没有新依赖。选择它的理由很实际：
 *
 * 1. 三个平台（Electron / 浏览器 / Android WebView）都能跑，不需要 WASM 或模型文件；
 * 2. **确定性**：同样的文本永远得到同样的向量，于是「索引过期了吗」可以用
 *    内容哈希判断，测试也能逐位断言；
 * 3. 对中文小说够用：人物名、地名、招式名这类专有名词在字面上重复出现，
 *    正是「相关历史片段」最需要召回的东西。
 *
 * 与真正的 embedding 的差距写在界面上：检索页明确标注「字面相似检索，
 * 不是语义模型」。同义词、代词指代召回不到，这是已知边界。
 *
 * 向量以 `{ dims, counts }` 的**稀疏对象**保存（键是维度下标）。稠密数组
 * 每块 256 个数字，一本书几千块时会白白膨胀 IndexedDB；而且计数只有几十个
 * 非零位，稀疏表示既小又 JSON 友好。
 */

export const EMBEDDING_VERSION = 'hash-v1'
export const EMBEDDING_DIM = 256

/** FNV-1a 的十六进制结果转成数值桶下标。 */
function bucketOf(token, dims) {
  return parseInt(fnv1a32(token), 16) % dims
}

/**
 * 判断是不是「中文/日文汉字」。
 *
 * 只把 CJK 统一表意文字当字：标点、全角符号、假名不参与 n-gram。
 * 段落里的标点如果也算 token，「，」「。」这类会变成所有文本共有的高频词，
 * IDF 虽然能压住它们，但白白占用了向量维度。
 */
function isCJK(cp) {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 统一表意文字
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意文字
    (cp >= 0x20000 && cp <= 0x2fa1f) // 扩展 B 及以后
  )
}

function isLatinOrDigit(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
}

/**
 * 分词。**导出是为了让测试能直接断言「哪些东西算 token」**。
 *
 * - 中文：每个字一个 token（`c:`），相邻两字一个 bigram（`b:`）。
 *   单字保证召回，bigram 让「林昭」与「林昭之死」有区分度。
 * - 拉丁字母/数字：连续的一段算一个词（`w:`），小写化。
 *   单个字母不产生 token（「A 君」里的 A 信息量太低），单个数字保留。
 *
 * 前缀（c/b/w）是必要的：不同来源的 token 若拼出同一个字符串，
 * 哈希会撞到同一个桶，等于把「字符 a」与「英文单词 a」当成一回事。
 */
export function embeddingTokens(text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = []
  let cjkRun = []
  let latin = ''

  const flushCJK = () => {
    if (!cjkRun.length) return
    for (const ch of cjkRun) tokens.push('c:' + ch)
    for (let i = 0; i + 1 < cjkRun.length; i++) tokens.push('b:' + cjkRun[i] + cjkRun[i + 1])
    cjkRun = []
  }
  const flushLatin = () => {
    if (latin.length >= 2 || (latin.length === 1 && latin >= '0' && latin <= '9')) {
      tokens.push('w:' + latin)
    }
    latin = ''
  }

  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    const width = cp > 0xffff ? 2 : 1
    if (isCJK(cp)) {
      flushLatin()
      cjkRun.push(ch)
    } else if (isLatinOrDigit(ch)) {
      flushCJK()
      latin += ch
    } else {
      flushCJK()
      flushLatin()
    }
    i += width
  }
  flushCJK()
  flushLatin()
  return tokens
}

/** 把 token 列表变成稀疏计数向量。 */
export function embedTokens(tokens, dims = EMBEDDING_DIM) {
  const counts = {}
  for (const token of tokens || []) {
    if (!token) continue
    const idx = bucketOf(token, dims)
    counts[idx] = (counts[idx] || 0) + 1
  }
  return { dims, counts }
}

/** 文本 → 稀疏计数向量。空文本得到空向量（不是全零数组）。 */
export function embedText(text, dims = EMBEDDING_DIM) {
  return embedTokens(embeddingTokens(text), dims)
}

/**
 * 文档频率 IDF。
 *
 * `idf[i] = log((N + 1) / (df[i] + 1)) + 1`
 *
 * 平滑（+1）保证只出现在一篇里的词权重有限，而不是 `log(N)` 那样随书越长
 * 越大；常数 1 保证至少有一个正权重，不会出现「所有词都被判成没用」。
 *
 * **必须在查询时按当前书的全部 chunk 现算**。若把 IDF 烘进存下来的向量，
 * 新增一章就会让新旧向量的权重空间不一致，余弦相似度算出来的是两个坐标系
 * 里的夹角 —— 分数看起来正常，排序却是错的。
 */
export function buildIdf(vectors, dims = EMBEDDING_DIM) {
  const df = new Float64Array(dims)
  let n = 0
  for (const v of vectors || []) {
    if (!v || !v.counts) continue
    n++
    for (const key of Object.keys(v.counts)) {
      const i = Number(key)
      if (Number.isFinite(i) && i >= 0 && i < dims) df[i] += 1
    }
  }
  const idf = new Float64Array(dims)
  for (let i = 0; i < dims; i++) idf[i] = Math.log((n + 1) / (df[i] + 1)) + 1
  return idf
}

/**
 * 应用 IDF 与次线性词频：`w = (1 + log(tf)) * idf`。
 *
 * 次线性 TF 抑制长文本靠重复某个词刷分；IDF 抑制「的了」「他说」这类
 * 所有章节都有的词。返回同样形状的稀疏向量，便于直接喂给余弦。
 */
export function applyIdf(vector, idf, dims = EMBEDDING_DIM) {
  const counts = {}
  if (!vector || !vector.counts) return { dims, counts }
  for (const key of Object.keys(vector.counts)) {
    const i = Number(key)
    const tf = Number(vector.counts[key]) || 0
    const w = Number(idf?.[i])
    if (tf <= 0 || !Number.isFinite(w)) continue
    counts[key] = (1 + Math.log(tf)) * w
  }
  return { dims, counts }
}

/** 余弦相似度。两个空向量返回 0（不是 NaN —— NaN 会污染排序）。 */
export function cosineSimilarity(a, b) {
  if (!a || !b || !a.counts || !b.counts) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (const key of Object.keys(a.counts)) {
    const wa = a.counts[key]
    na += wa * wa
    const wb = b.counts[key]
    if (wb) dot += wa * wb
  }
  for (const key of Object.keys(b.counts)) {
    const wb = b.counts[key]
    nb += wb * wb
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
