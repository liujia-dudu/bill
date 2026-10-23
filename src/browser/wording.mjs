// Page wording the program acts on, kept in one place so the guard, the fill tools,
// the review check and the confirmed submission agree on what a page says.
// Functions that run inside the page cannot import this module; they receive a
// pattern from inPage() as an argument.

const union = (...patterns) => new RegExp(patterns.map((pattern) => pattern.source).join('|'), 'i');
export const inPage = (pattern) => ({ source: pattern.source, flags: pattern.flags });

// --- Submitting and other side effects ---
export const SUBMIT_TEXT = /提交|确认开票|申请开票|立即开票|开具发票|submit|apply/i;
// Codes, messages and payments are never ours to trigger, even after a confirmation.
export const SIDE_EFFECT_TEXT = /验证码|发送|支付|购买|付款|pay|purchase|send/i;
// Our own trusted clicks on these are stopped by the page guard; the user's confirmed
// submission carries a one-click pass.
export const GUARDED_TEXT = union(SUBMIT_TEXT, SIDE_EFFECT_TEXT, /同意|confirm|agree/i);
// The fill Agent may not press anything that reads like an action on the order.
export const AGENT_FORBIDDEN_TEXT = union(GUARDED_TEXT, /开票|申请|确认|删除|delete/i);
// A control that sends the form. A <button> without a type is type=submit, but
// outside a form it submits nothing (formless Vant buttons such as 公司/个人), so only
// its text can say it submits.
export const isSubmitControl = ({ type, inForm, text = '' }) =>
  !SIDE_EFFECT_TEXT.test(text) && ((type === 'submit' && inForm) || SUBMIT_TEXT.test(text));

// --- Fill-time controls ---
export const NEXT_STEP_TEXT = /下一|next|继续/i;
export const NAVIGATION_TEXT =
  /^(?:下一步|继续填写|下一页|返回|上一步|更多内容(?:\s*[（(]非必填[）)])?|展开(?:更多)?|收起|next|back)$/i;
export const SEARCH_TEXT =
  /^(?:查询|搜索|查找|查询税号|税号查询|查询企业|企业查询|查询公司|公司查询|search)$/i;
export const BUYER_TYPE_LABEL = /抬头类型|购买方类型|发票抬头类型|抬头性质|开票类型|buyer\s*type/i;
export const BUYER_TYPE_CHOICE =
  /^(?:公司|企业|单位|企业单位|个人|非企业|非企业单位|个人或事业单位|事业单位|其他|personal|individual|enterprise|company)$/i;
export const ENTERPRISE_TEXT = /企业|公司|单位|enterprise|company/i;
export const NOT_ENTERPRISE_TEXT = /非企业|个人/;
export const PERSONAL_TEXT = /个人|personal|individual/i;
export const SELLER_TEXT = /销售方|销方|商家信息|seller/i;
export const TAX_LABEL = /税号|纳税人识别号|统一社会信用代码/;

// --- Agreements ---
export const AGREEMENT_TEXT = /同意|已阅读|协议|条款|隐私|授权|agree|terms|privacy/i;
// Marketing opt-ins are never ticked on the user's behalf.
export const MARKETING_TEXT = /营销|订阅|推送|广告|促销|优惠|会员|marketing|subscribe|newsletter/i;

// --- After the confirmed click ---
export const CONFIRM_BUTTON =
  /^(?:确认|确定|确认提交|确认开票|确认无误|提交|继续提交|立即开票|是|好|好的|ok|yes|confirm|submit)$/i;
export const KNOWN_DIALOG = /确认|确定|提交|开票|核对|是否|无误|抬头|邮箱|税号|发票|信息/;
export const SUCCESS_TEXT =
  /提交成功|申请成功|开票成功|开具成功|已受理|受理成功|提交完成|申请已提交|发票已提交|开票申请已受理/;
// Plain failure wording; the wider set also covers hints such as "如有误" that a
// second confirmation may carry as a warning.
export const FAILURE_TEXT = /失败|错误|不能为空|格式不正确/;
export const ERROR_TEXT = union(FAILURE_TEXT, /请填写|请输入|有误|异常/);

// --- Page states that stop a fill before it starts ---
// Delivery pages such as the tax bureau's 数电发票 viewer only show the invoice
// number and PDF/OFD/XML downloads.
export const ISSUED_TEXT =
  /发票已开具|开票成功|已开票|发票代码[\s\S]*发票号码|下载发票|查看发票|数电发票号码|您已接收到.{0,30}电子发票|(?:PDF|OFD|XML)\s*下载[\s\S]{0,40}(?:PDF|OFD|XML)\s*下载/;
export const ALREADY_SUBMITTED_TEXT = /发票已提交|申请已提交|已申请开票|开票申请已受理/;
export const WECHAT_ONLY_TEXT = /请在微信|微信客户端|请使用微信/;
export const EXPIRED_TEXT = /已过期|链接失效|超过开票|开票码已失效/;
