import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ensureDir } from './util.js'

const SEEDS = [
  ['我要验牌', '直播/评论区的求证梗，用来质疑对方身份、证据或说法。', '对方说得太离谱时，可以半开玩笑地说“先验个牌”。', '求证 证据 直播 弹幕', '低'],
  ['啊？', '最低成本的惊讶/无语反应，适合信息量过大或剧情反转。', '单独回一个“啊？”就很有戏。', '惊讶 无语 弹幕', '低'],
  ['我是真人', 'AI 时代自证不是机器人/脚本的梗，常带自嘲。', '被怀疑是 AI 或客服时用。', 'AI 真人 自嘲', '低'],
  ['活人感', '在模板化、AI 内容里显得真实、有瑕疵、有生活气。', '夸人或自夸“有活人感”。', '真实 人味 生活', '低'],
  ['抽象力', '把压力、窘境转化成荒诞玩梗的能力。', '遇到离谱事时自嘲“我的抽象力又提升了”。', '抽象 发疯 幽默', '低'],
  ['主体性', '强调“我自己决定”，不围着别人转。', '聊边界、拒绝内耗时用。', '自我 边界 独立', '低'],
  ['边界感', '知道什么该管、什么不该管，不越界。', '夸人相处舒服，或提醒对方别越界。', '边界 社交 舒服', '低'],
  ['外耗', '把压力向外释放一点，不全部憋在自己身上。', '劝人别内耗过头时用。', '内耗 压力 情绪', '低'],
  ['班味', '上班上久了身上那股疲惫、社畜感。', '自嘲“今天班味很重”。', '打工人 疲惫 上班', '低'],
  ['做完你的做你的', '排队/控场语气，意思是先把手头这个做完。', '催进度、排任务时用。', '职场 排队 任务', '低'],
  ['真没空陪你闹了', '拒绝无效拉扯和情绪消耗。', '对方一直作/纠缠时用。', '拒绝 拉扯 边界', '低'],
  ['爱你老己', '把自己当成需要照顾的人，先爱自己。', '自我关怀、累了想歇时用。', '自爱 自我关怀', '低'],
  ['敬自己一杯', '给自己一点仪式感和肯定。', '完成一件小事、想奖励自己时用。', '自爱 仪式感', '低'],
  ['最棒的小羊', '把自己/对方当成值得夸奖的小动物，软萌鼓励。', '安慰、夸奖时用。', '鼓励 可爱 安慰', '低'],
  ['丝瓜汤文学', '把长辈式关心里的错位和压力写成幽默段子。', '吐槽家里催问、过度关心时用。', '家庭 代际 吐槽', '低'],
  ['低山臭水遇知音', '荒诞版“高山流水遇知音”，形容离谱的人互相懂。', '遇到同频的损友时用。', '抽象 知音 损友', '低'],
  ['房子着火我睡觉', '用极端淡定表达摆烂/无所谓。', '自嘲“随便吧，房子着火我睡觉”。', '摆烂 淡定 抽象', '低'],
  ['此人绝非扇贝', '无厘头夸人/损人，重点在“不是普通小角色”。', '调侃离谱操作时用。', '抽象 无厘头', '低'],
  ['梆梆就是两拳', '开玩笑式的“揍你两拳”，表达亲昵或无语。', '只对熟人、轻松语境用。', '打闹 亲昵 玩笑', '中'],
  ['yyds', '永远的神，夸人/物很厉害。', '真诚夸奖时用，别每句都加。', '夸奖 缩略语', '低'],
  ['xswl', '笑死我了。', '觉得好笑时用。', '笑 缩略语', '低'],
  ['u1s1', '有一说一，表示说实话。', '认真表达观点前用。', '认真 缩略语', '低'],
  ['bdjw', '不懂就问。', '提问前用，显得随意。', '提问 缩略语', '低'],
  ['破防了', '心理防线被击穿，被戳中/整难受了。', '被感动、被扎心时用。', '情绪 扎心', '低'],
  ['偷感', '偷偷摸摸、不太敢声张的感觉。', '自嘲“偷感很重”。', '自嘲 社交', '低'],
  ['内卷', '过度竞争、互相消耗。', '聊学习/职场压力时用。', '竞争 压力', '低'],
  ['躺平', '不再拼命卷，选择低消耗生活。', '累了想摆烂时用。', '摆烂 反内卷', '低'],
  ['画饼', '给对方空头承诺。', '吐槽老板/承诺不兑现时用。', '职场 承诺', '低'],
  ['显眼包', '在人群里很跳脱、很抢眼的人/物。', '调侃爱出风头或很搞笑的人。', '搞笑 抢眼', '低'],
  ['city不city', '洋气不洋气、时髦不时髦。', '调侃穿搭/生活方式。', '时髦 生活方式', '低'],
  ['松弛感', '不紧绷、不焦虑的从容状态。', '夸人状态好时用。', '从容 生活', '低'],
  ['搭子', '一起做某件事的轻量伙伴。', '饭搭子、旅游搭子、摸鱼搭子。', '社交 伙伴', '低'],
  ['电子榨菜', '吃饭时用来下饭的视频/内容。', '推荐下饭剧/视频时用。', '下饭 视频', '低'],
  ['嘴替', '替自己说出心里话的人。', '看到说出自己心声的评论时用。', '共鸣 评论', '低'],
  ['发疯文学', '用夸张、失控的文字表达情绪。', '压力大时玩梗，不真的攻击人。', '发疯 情绪', '低'],
  ['确诊为XX', '自嘲式“确诊”成某种状态/角色。', '“确诊为摸鱼型人格”。', '自嘲 玩梗', '低'],
  ['牛马', '自嘲被使唤、辛苦干活的人。', '打工人自嘲时用。', '打工人 自嘲', '低'],
  ['打工人', '上班族自嘲称呼。', '聊上班、加班时用。', '上班 自嘲', '低'],
  ['摸鱼', '上班/上课时偷偷偷懒。', '轻松语境自嘲。', '偷懒 上班', '低'],
  ['纯爱战神', '在感情里特别专一、认真的人。', '夸人深情或自嘲。', '恋爱 纯爱', '低'],
  ['大冤种', '白白吃亏、很倒霉的人。', '自嘲或心疼对方。', '倒霉 自嘲', '低'],
  ['小丑竟是我自己', '自嘲白忙一场、表错情。', '发现自作多情时用。', '自嘲 尴尬', '低'],
  ['芭比Q', '完蛋了、搞砸了。', '小翻车时用。', '翻车 完蛋', '低'],
  ['退退退', '把讨厌的人/事赶走，带手势梗。', '拒绝晦气、驱散倒霉时用。', '拒绝 驱散', '低'],
  ['我太难了', '表达生活/任务很难。', '轻度抱怨时用。', '抱怨 难', '低'],
  ['奥利给', '加油、打气。', '鼓励自己/别人时用。', '加油 鼓励', '低'],
  ['绝绝子', '非常绝、非常厉害/无语，语义看语气。', '别高频用，容易显得过时。', '夸张 评价', '低'],
  ['蚌埠住了', '绷不住了，忍不住笑/哭/崩溃。', '情绪绷不住时用。', '情绪 谐音', '低'],
  ['夺笋', '多损，吐槽对方太损。', '朋友互损时用。', '损友 吐槽', '低'],
  ['凡尔赛', '用低调口气炫耀。', '识别/调侃炫耀时用。', '炫耀 反差', '低'],
  ['社死', '社会性死亡，公开场合极度尴尬。', '自嘲尴尬经历。', '尴尬 社死', '低'],
  ['情绪价值', '让人感到被理解、被支持的能力。', '夸人相处舒服时用。', '情绪 陪伴', '低'],
  ['钝感力', '对负面刺激不那么敏感、能扛。', '劝人别太在意时用。', '心态 抗压', '低'],
  ['passion', '激情、热爱，带大喊梗。', '给自己/别人打气时用。', '热情 打气', '低'],
  ['命运的齿轮开始转动', '人生转折点开始。', '遇到重大变化时用。', '转折 命运', '低'],
  ['轻舟已过万重山', '熬过难关后的释然。', '完成任务/走出低谷时用。', '释然 过关', '低'],
  ['你人还怪好嘞', '表面夸、实际带点反讽的感谢。', '对方做了让人哭笑不得的事时用。', '反讽 感谢', '低'],
  ['泰裤辣', '太酷啦的谐音。', '夸人/事很酷时用。', '夸奖 谐音', '低'],
  ['多巴胺', '高饱和、明亮快乐的颜色/风格。', '夸穿搭、配色时用。', '穿搭 颜色', '低'],
  ['美拉德', '棕色系、温暖复古的穿搭风格。', '聊秋冬穿搭时用。', '穿搭 风格', '低'],
  ['公主请上车', '把对方当公主哄的玩梗句式。', '亲密/玩笑语境用。', '哄人 玩梗', '低'],
  ['V我50', '肯德基疯狂星期四的玩梗转账句式。', '周四玩梗，不要真的频繁要钱。', '肯德基 玩梗', '低'],
  ['一整个XX住', '“一整个人愣住/爱住”的夸张句式。', '表达强烈反应时用。', '夸张 句式', '低'],
  ['无语子', '无语的可爱化说法。', '轻度无语时用，别高频。', '无语 语气', '低'],
  ['集美', '姐妹的谐音称呼。', '对女性朋友/群体用。', '称呼 姐妹', '低'],
  ['九漏鱼', '九年义务教育漏网之鱼，调侃没文化。', '容易冒犯人，关系很熟才用。', '调侃 文化', '中'],
  ['普信男', '普通却过度自信的男性，带贬义。', '攻击性强，不建议主动使用。', '性别 贬义', '高'],
  ['下头', '让人瞬间失去好感。', '表达扫兴时用。', '好感 扫兴', '低'],
  ['上头', '一时冲动、沉迷。', '“太上头了”。', '沉迷 冲动', '低'],
  ['氛围感', '整体气质/画面感很好。', '夸照片、场景时用。', '气质 画面', '低'],
  ['笑不活了', '笑得受不了。', '觉得非常好笑时用。', '笑 夸张', '低'],
  ['谁懂啊', '寻求共鸣的感叹。', '遇到共鸣场景时用。', '共鸣 感叹', '低'],
  ['家人们', '把听众当家人的称呼。', '轻松开场时用。', '称呼 开场', '低'],
  ['咱就是说', '口语化开场，表示“说真的”。', '别每段都加。', '口语 开场', '低'],
  ['属于是', '“属于是……”的省略句式，表示总结。', '“属于是精准破防了”。', '句式 总结', '低'],
  ['栓Q', 'thank you 的谐音，常带无奈。', '感谢/无语时用。', '感谢 谐音', '低'],
  ['真的会谢', '表面感谢、实际很无语。', '被坑/无奈时用。', '反讽 无语', '低'],
  ['海克斯科技', '调侃食品添加剂/科技感过头。', '别用来造谣具体品牌。', '食品 科技', '中'],
  ['科技与狠活', '调侃食品加工里的添加剂。', '轻松吐槽，不造谣。', '食品 吐槽', '中'],
  ['指鼠为鸭', '把明显的事说成另一回事，讽刺颠倒黑白。', '公共事件语境，别乱扣帽子。', '讽刺 公共', '中'],
  ['吗喽', '猴子/自嘲打工人。', '自嘲疲惫时用。', '自嘲 打工人', '低'],
  ['早八', '早上八点的课/班。', '学生/上班族自嘲。', '上学 早起', '低'],
  ['脆皮大学生', '身体/心理很脆弱的大学生，自嘲。', '自嘲容易受伤/生病。', '学生 自嘲', '低'],
  ['特种兵旅游', '行程极满、极省时的旅游方式。', '聊旅游时用。', '旅游 行程', '低'],
  ['Citywalk', '城市里漫无目的散步。', '聊周末休闲时用。', '散步 城市', '低'],
  ['电子宠物', '线上养成/陪伴型虚拟角色。', '调侃虚拟陪伴。', '虚拟 陪伴', '低'],
  ['赛博XX', '给事物加“赛博”前缀，表示科技/虚拟化。', '“赛博许愿”。', '科技 虚拟', '低'],
]

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/gu, '').trim()
}

export class MemeKnowledge {
  constructor(dataDir, bus) {
    this.bus = bus
    ensureDir(dataDir)
    this.file = join(dataDir, 'memes-text.sqlite')
    this.db = new DatabaseSync(this.file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS text_memes (
        id TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '',
        meaning TEXT NOT NULL,
        usage TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT '低',
        uses INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS text_memes_term ON text_memes(term);
    `)
    this.seed()
  }

  seed() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM text_memes').get()
    if (Number(row.n) > 0) return
    const now = Date.now()
    const insert = this.db.prepare(`
      INSERT INTO text_memes (id, term, aliases, meaning, usage, tags, risk, uses, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `)
    for (const [term, meaning, usage, tags, risk] of SEEDS) {
      insert.run(`meme-${randomUUID()}`, term, '', meaning, usage, tags, risk, now, now)
    }
    this.bus?.log('info', `网络梗知识库已初始化 ${SEEDS.length} 条`)
  }

  search(query, options = {}) {
    const q = normalize(query)
    const limit = Math.max(1, Math.min(Number(options.limit) || 3, 10))
    const rows = this.db.prepare('SELECT * FROM text_memes').all()
    if (!q) {
      return rows.sort((a, b) => b.uses - a.uses || b.updated_at - a.updated_at).slice(0, limit)
        .map((row) => this.public(row))
    }
    const scored = rows.map((row) => {
      const term = normalize(row.term)
      const aliases = normalize(row.aliases)
      const tags = normalize(row.tags)
      const meaning = normalize(row.meaning)
      let score = 0
      if (term === q) score += 100
      else if (term.includes(q) || q.includes(term)) score += 60
      if (aliases.includes(q)) score += 45
      if (tags.includes(q)) score += 30
      if (meaning.includes(q)) score += 12
      return { row, score }
    }).filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.row.uses - a.row.uses)
      .slice(0, limit)
    if (scored.length === 0) return []
    for (const item of scored) {
      this.db.prepare('UPDATE text_memes SET uses = uses + 1 WHERE id = ?').run(item.row.id)
    }
    return scored.map((item) => this.public(item.row))
  }

  public(row) {
    return {
      id: row.id,
      term: row.term,
      aliases: row.aliases,
      meaning: row.meaning,
      usage: row.usage,
      tags: row.tags,
      risk: row.risk,
      uses: row.uses,
    }
  }

  add(entry) {
    const term = String(entry.term ?? '').trim()
    if (!term) throw new Error('梗词不能为空')
    const now = Date.now()
    const id = entry.id || `meme-${randomUUID()}`
    const existing = this.db.prepare('SELECT id FROM text_memes WHERE term = ?').get(term)
    if (existing) {
      this.db.prepare('UPDATE text_memes SET aliases=?, meaning=?, usage=?, tags=?, risk=?, updated_at=? WHERE id=?')
        .run(entry.aliases || '', entry.meaning || '', entry.usage || '', entry.tags || '', entry.risk || '低', now, existing.id)
      return this.db.prepare('SELECT * FROM text_memes WHERE id = ?').get(existing.id)
    }
    this.db.prepare(`
      INSERT INTO text_memes (id, term, aliases, meaning, usage, tags, risk, uses, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, term, entry.aliases || '', entry.meaning || '', entry.usage || '', entry.tags || '', entry.risk || '低', now, now)
    return this.db.prepare('SELECT * FROM text_memes WHERE id = ?').get(id)
  }

  list(limit = 50) {
    return this.db.prepare('SELECT * FROM text_memes ORDER BY uses DESC, updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(Number(limit) || 50, 200))).map((row) => this.public(row))
  }

  remove(id) {
    return this.db.prepare('DELETE FROM text_memes WHERE id = ?').run(String(id)).changes > 0
  }

  stats() {
    const row = this.db.prepare('SELECT COUNT(*) AS total, SUM(uses) AS uses FROM text_memes').get()
    return { total: Number(row.total) || 0, uses: Number(row.uses) || 0, file: this.file }
  }

  close() {
    try { this.db.close() } catch {}
  }
}
