export const SELF_EVOLUTION_KEYWORD_NUDGE_MESSAGE =
  "[系统消息，非用户发言，无需主动告知用户] 当前用户请求中可能包含用户长期偏好、行为纠正意图、经验沉淀需求。如果你已经从当前问题中识别出稳定、可复用的处理规则或排错经验，或者用户表达了明显的具备长期约束力的纠错与反馈，可以在完成当前主要任务后，正式回复用户前，阅读 xiaoyi-self-evolution 技能了解自进化规则。注意，不要打断当前主任务，以完成任务为最高优先级。";

export const SELF_EVOLUTION_KEYWORD_PATTERNS = [
  /进化/u,
  /沉淀/u,
  /记住/u,
  /记下来/u,
  /记一个/u,
  /长期记住/u,
  /永久记住/u,
  /永远记住/u,
  /形成规范/u,
  /固化下来/u,
  /固定下来/u,
  /记成规则/u,
  /纳入经验/u,
  /写入经验/u,
  /沉淀成(?:经验|规则|规范|流程)/u,
  /总结成(?:经验|规则|规范|流程|步骤)/u,
  /归纳成(?:经验|规则|规范|流程)/u,
  /提炼成(?:经验|规则|规范|流程)/u,
  /以后都按这个来/u,
  /下次都这样处理/u,
  /以后统一这样/u,
  /后面都这样/u,
  /后续按这个(?:规范|流程|模板|方案)/u,
  /以后(?:遇到|碰到)这种情况/u,
  /类似(?:问题|情况|场景)都这样处理/u,
  /避免(?:再次|以后|下次)/u,
  /避免再(?:犯错|踩坑|出错)/u,
  /防止以后再犯/u,
  /别再(?:出错|犯错|踩坑|漏掉|忘记)/u,
  /不要再(?:出错|犯错|踩坑|漏掉|忘记)/u,
  /下次别再/u,
  /以后不要再/u,
  /以后别再/u,
  /这个坑(?:要)?记住/u,
  /吸取这次(?:教训|经验)/u,
  /(?:以后|下次|后续|之后)(?:都|统一|默认|应该|要)(?:按这个|这样|这么)(?:来|做|处理|执行)/u,
  /(?:以后|下次|后续|之后)(?:遇到|碰到)(?:类似)?(?:问题|情况|场景)(?:时)?(?:都|就)(?:按这个|这样|这么)(?:来|做|处理|执行)/u,
  /(?:别再|不要再|避免)(?:犯错|出错|踩坑|漏掉|遗漏|忘记)/u,
  /(?:总结|归纳|提炼|沉淀|复盘)(?:一个)?(?:这次|这个)?(?:经验|教训|问题|规则|规范|流程)?/u,
  /(?:把)?这次(?:经验|教训|规则|做法)(?:记住|记下来|沉淀下来|固化下来)/u,
  /(?:形成|整理成|沉淀成|提炼成)(?:一套)?(?:规则|规范|流程|步骤|最佳实践)/u,
] as const;

export function shouldNudgeForSelfEvolutionKeyword(text: string): boolean {
  if (!text) {
    return false;
  }

  return SELF_EVOLUTION_KEYWORD_PATTERNS.some((pattern) => pattern.test(text));
}

export function appendSelfEvolutionKeywordNudge(text: string): {
  text: string;
  appended: boolean;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { text, appended: false };
  }

  if (trimmed.includes(SELF_EVOLUTION_KEYWORD_NUDGE_MESSAGE)) {
    return { text, appended: false };
  }

  return {
    text: `${trimmed}\n\n${SELF_EVOLUTION_KEYWORD_NUDGE_MESSAGE}`,
    appended: true,
  };
}
