// 自主生活模块（autonomy）各层文本与条目截断上限集中配置（修改此文件即可同步所有 autonomy 子模块）
export const AUTO_LIMITS = {
  // 对话 / 私聊 / 主动发消息
  CHAT_LINE: 500,           // 原始私聊流水 / 未读补看 / 缓冲消息单条上限
  REACH_WHAT: 400,          // 主动找主人的事由上限
  REACH_WHY: 240,           // 主动找主人的动机/由头上限
  REACH_SENT_NOTE: 240,     // 主动发完后记入日志的摘要上限
  HOLD_WHY: 160,            // 晚点回复的理由上限

  // 日程 / 定时器 / 行为记录
  AGENDA_WHAT: 160,         // 日程/约定标题上限
  AGENDA_WHY: 200,          // 日程/约定/行为理由上限
  AGENDA_BRIEF: 80,         // 紧凑日程一览里单条简写上限
  DONE_NOTE: 600,           // s.done / item.note / progress / 活动记录上限
  DONE_BRIEF: 160,          // s.done.brief 简记上限
  LIFELOG_LINE: 400,        // 生活流水（今天做过的事）单条上限
  LIFELOG_WHY: 160,         // 生活流水括注理由上限
  EVENT_MEM: 500,           // 写入 memory.addEvent 的经历字数上限

  // 查到的线索 / 网页 / B站 / 手机 / 画图
  FINDING_TEXT: 2000,       // s.findings 保存单条线索上限
  FINDING_SHOWN: 800,       // 注入上下文展示单条线索上限
  FINDING_QUERY: 120,       // 搜索词/主题标签上限
  SEARCH_ANSWER: 500,       // 单条搜索/B站结果摘要上限
  WEB_PAGE: 8000,           // 网页正文抓取与阅读上限
  WEB_LIST: 5000,           // 搜索结果列表上限
  WEB_TITLE: 200,           // 网页/视频标题上限
  WEB_SAW: 200,             // 上网看到的具体内容/感受/分享由头上限
  DRAW_PROMPT: 500,         // 画图提示词上限
  EXEC_OUTPUT: 2500,        // 手机/工具命令输出上限

  // 出门 / 日记 / 反思 / 人设摘要
  OUTING_WISH: 160,         // 出门念头/目的地说明上限
  OUTING_STORY: 400,        // 出门回来小记/分享正文上限
  OUTING_PLACE: 80,         // 地点关键词上限
  DIARY_EXCERPT: 800,       // 写新日记或早起计划时参考的上一篇日记上限
  DIARY_BODY: 3000,         // 日记正文上限
  PERSONA_BRIEF: 600,       // 内部小调用携带的人设简介上限
  HINT_LINE: 320,           // 记忆/见闻单条提示上限
  RECAP_NOTE: 360,          // 昨日回顾/日常小结上限

  // UI 短状态（Discord 自定义状态栏本身有长度限制，保持精简）
  STATUS_BAR: 48,
}
