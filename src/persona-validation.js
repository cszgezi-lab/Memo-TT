// Fixed, content-free labels shared by validation, diagnostics and feedback.
export const PERSONA_ISSUES=Object.freeze({
  missing_name:'缺少人物姓名',invalid_text:'档案正文缺失或不是文字',unsafe_text:'档案正文含脚本或内部注入标记',
  invalid_floors:'来源楼号缺失或不在本批原文中',ambiguous_name:'姓名无法唯一对应本批人物',duplicate_profile:'同一人物返回了多份档案',
  empty_profile:'新人物没有可独立阅读的档案',invalid_updates:'局部修改不是列表',unknown_ref:'局部修改引用的片段不属于该人物或不存在',
  duplicate_ref:'同一片段被重复修改',empty_edit:'局部修改内容为空或不是文字',invalid_edit_floors:'局部修改的依据楼号不在本批',unsafe_edit:'局部修改含脚本或内部注入标记',
  repair_target:'纠错回答遗漏目标人物或返回了其它人物',invalid_json:'回答不是完整JSON',missing_profiles:'回答缺少人物列表',
  nonliteral_edit_quote:'局部修改的evidence.floor在本批，但evidence.quote不是该楼source的连续逐字原文。按validation的editRef/evidenceFloor定位，从该楼source直接复制可归属本人物且支持修改的完整连续原句；不改主语、指代、标点或翻译原句。没有可靠原句时撤下该项无据修改，保留原片段，其它有据人物信息仍可更新。',
  unapplied_revision:'本次整份改动未通过核对：从source重新选择逐字连续、可归属本人物的依据，逐项核对changeCheck/development及B/N局改；不改字或拼接引文，不凭场景标题推断身份。只修有确证的当前变化；无可靠转折则unchanged并保留有效设定，不用空profiles跳过目标。',
});
export const PERSONA_RECOVERY_VERSION=1;
export function personaValidationError(issue,details={}){
 return Object.assign(new Error(PERSONA_ISSUES[issue]??'人物回答未通过校验'),{code:'PERSONA_RESPONSE_INVALID',details:{stage:'validate',reason:'persona_fields',modelRole:'dynamicPersona',personaIssue:issue,...details}});
}
