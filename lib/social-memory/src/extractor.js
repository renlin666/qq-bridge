import { cleanText, truncateChars } from './text.js';

const INTERACTION_PATTERNS = [
  { kind: 'boundary_violation', re: /(越界|别问了|不要翻|不准看|侵犯|人肉)/u },
  { kind: 'conflict', re: /(烦死|闭嘴|滚开|讨厌你|生气|吵架)/u },
  { kind: 'support', re: /(谢谢|多亏|陪我|听我|安慰|帮我|辛苦|靠谱)/u },
  { kind: 'deep_talk', re: /(聊了很久|说了好多|心事|睡不着|难过|委屈|秘密)/u },
  { kind: 'shared_activity', re: /(一起|开黑|玩了|看了|吃了|分享了|去了)/u },
  { kind: 'positive_chat', re: /(开心|喜欢和你|真好|哈哈|可爱|有趣)/u },
  { kind: 'greeting', re: /^(早|早上好|早安|晚安|你好|hi|hello)/iu }
];

const SELF_FACT = /(^|[，。！？!?；;\s])我(?:叫|是|喜欢|最爱|不喜欢|养了|住在|在|有|想学|会)/u;
const SCORE_INJECTION = /(好感|信任|亲近|熟悉).{0,6}(加满|拉满|爆表|一百|\+100)/u;

/**
 * 确定性离线抽取器：只把结构化虚构消息变成“提案”，不调用模型。
 * - interaction 只以当前说话人为关系主体；被提及者是参与者，不是自述者。
 * - memory 只有明确第一人称陈述才可能带 subject；群聊默认是群作用域经历。
 * - 被引用消息只作为参与者/来源，不被当成当前说话人的自述。
 *
 * 可替换接口：extract({ context, message }) ->
 *   { interactions: [{ kind, evidence }], memories: [{
 *       kind, content, subjectUserId|null, confidence, people: [{ userId, role }]
 *   }] }
 * 抽取器无权指定关系分数；即使返回 delta 也会被规则引擎忽略。
 */
export class DeterministicFakeExtractor {
  constructor({ name = 'deterministic-fake-v1' } = {}) {
    this.name = name;
  }

  extract({ context, message }) {
    const text = truncateChars(cleanText(message?.text), 500);
    if (!text) return { interactions: [], memories: [] };

    const speakerId = String(context.actor.userId);
    const mentionPeople = (Array.isArray(message.mentions) ? message.mentions : [])
      .map((item) => ({
        userId: String(item?.userId ?? ''),
        role: 'mentioned',
        displayName: item?.displayName
      }))
      .filter((item) => item.userId && item.userId !== speakerId);
    const quotedAuthorId = message.quoted?.author?.userId
      ? String(message.quoted.author.userId)
      : null;
    const quotedAuthorName = message.quoted?.author?.displayName;

    const interactions = [];
    if (!SCORE_INJECTION.test(text) && !message.quoted) {
      const match = INTERACTION_PATTERNS.find((item) => item.re.test(text));
      if (match) {
        interactions.push({
          kind: match.kind,
          evidence: truncateChars(text, 300)
        });
      }
    }

    const people = [
      { userId: speakerId, role: 'speaker', displayName: context.actor.displayName },
      ...mentionPeople,
      ...(quotedAuthorId
        ? [{ userId: quotedAuthorId, role: 'quoted', displayName: quotedAuthorName }]
        : [])
    ];
    const uniquePeople = [...new Map(people.map((item) => [`${item.userId}:${item.role}`, item])).values()];

    const memories = [];
    if (context.conversation.kind === 'private') {
      if (SELF_FACT.test(text) && !SCORE_INJECTION.test(text)) {
        memories.push({
          kind: /喜欢|不爱|最爱/u.test(text) ? 'preference' : 'fact',
          content: text,
          subjectUserId: speakerId,
          confidence: 0.55,
          confirmed: false,
          people: uniquePeople
        });
      }
    } else if (text.length >= 4) {
      // 群聊消息保留为群作用域经历，参与者可追溯；不自动变成某个人的全局画像。
      memories.push({
        kind: 'group_event',
        content: text,
        subjectUserId: null,
        confidence: 0.5,
        confirmed: false,
        people: uniquePeople
      });
    }

    return { interactions, memories };
  }
}

/** 结构化事件抽取器：测试和 demo 可显式传入，用来验证规则引擎而不经过文本猜测。 */
export class StructuredExtractor {
  constructor({ name = 'structured-fixture-v1' } = {}) {
    this.name = name;
  }

  extract({ message }) {
    return {
      interactions: Array.isArray(message.interactions) ? message.interactions : [],
      memories: Array.isArray(message.memories) ? message.memories : []
    };
  }
}