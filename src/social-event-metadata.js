import { z } from 'zod';

export const SOCIAL_EVENT_KINDS = ['greeting','positive_chat','shared_activity','support','deep_talk',
  'conflict','boundary_violation','banter','annoyed','repair','serious','banter_preference','resolve_conflict'];
export const socialEventSchema = z.object({
  messageId: z.union([z.string().min(1).max(100), z.number().int().safe()]),
  kind: z.enum(SOCIAL_EVENT_KINDS),
  evidence: z.string().trim().min(1).max(500),
  preference: z.enum(['light','mutual','stop']).optional()
}).strict().refine(value => value.kind === 'banter_preference' ? !!value.preference : value.preference === undefined,
  'preference 只用于 banter_preference，且必须提供');
export const socialEventsSchema = z.array(socialEventSchema).max(3)
  .describe('本次回复的关系决定：无实质变化填[]；最多3项，绑定收到的原消息及逐字证据。禁止为普通闲聊加分。');

export function parseSocialEvents(value) {
  const parsed = socialEventsSchema.safeParse(value ?? []);
  if (!parsed.success) throw Object.assign(new Error('socialEvents 格式无效（最多3个来源绑定事件，禁止传分数或身份）'), { statusCode: 400 });
  return parsed.data;
}
