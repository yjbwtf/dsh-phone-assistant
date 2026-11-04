export const APP_NAMES = {
  'com.huawei.android.totemweather': '天气',
  'com.tencent.mm': '微信',
  'com.huawei.camera': '相机',
  'com.huawei.android.launcher': '桌面',
  'com.netease.cloudmusic': '网易云音乐',
  'com.tencent.mobileqq': 'QQ',
  'com.eg.android.AlipayGphone': '支付宝',
  'com.android.settings': '设置',
  'com.huawei.health': '运动健康',
  'com.huawei.browser': '浏览器',
  'com.ss.android.ugc.aweme': '抖音',
}

export function appLabel(app) {
  return APP_NAMES[app] || String(app || '').split('.').filter(Boolean).pop() || '手机'
}

function hasStep(steps, action) {
  return Array.isArray(steps) && steps.some((step) => step && step.action === action)
}

/**
 * Human-readable action for a Skill name. The final name is `应用-动作`,
 * e.g. 天气-查看当前天气 / 微信-发送消息 / 相机-拍摄.
 */
export function suggestSkillAction(app, steps = [], goal = '') {
  const text = String(goal ?? '')
  const hasText = hasStep(steps, 'text')
  const hasLaunch = hasStep(steps, 'launch')
  if (app === 'com.huawei.android.totemweather') return '查看当前天气'
  if (app === 'com.tencent.mm') return hasText ? '发送消息' : '打开聊天'
  if (app === 'com.huawei.camera') return /录像|视频/u.test(text) ? '录制视频' : '拍摄'
  if (app === 'com.netease.cloudmusic') return hasText ? '搜索并播放歌曲' : '播放歌曲'
  if (app === 'com.huawei.android.launcher') return '打开桌面'
  if (/播放|听歌|音乐/u.test(text)) return '播放歌曲'
  if (/录像|录制视频/u.test(text)) return '录制视频'
  if (/发送|发消息|回复/u.test(text)) return '发送消息'
  if (/搜索|搜/u.test(text)) return hasText ? '搜索并输入' : '搜索'
  if (/打开|启动/u.test(text)) return '打开应用'
  if (hasText) return '输入并搜索'
  if (hasLaunch) return '打开应用'
  return '操作流程'
}

export function suggestSkillName(app, steps = [], goal = '') {
  return `${appLabel(app)}-${suggestSkillAction(app, steps, goal)}`
}
