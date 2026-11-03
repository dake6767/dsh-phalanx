/** Native saved language wins over weighted Accept-Language for all group-feature refusals. */
export const nativeFeatureLocale = `function nativeFeatureChinese(ctx,request) {
  const preference = ctx.settings.describe().find(row => String(row.ns) === 'locale')?.value?.preference;
  const accepted = (request.headers.get('accept-language') || 'en').split(',').map((part, index) => {
    const [tag, ...parameters] = part.trim().split(';');
    const quality = parameters.find(value => value.trim().startsWith('q='));
    const q = quality ? Number(quality.trim().slice(2)) : 1;
    return {tag:tag.toLowerCase(),q,index};
  }).filter(row => Number.isFinite(row.q) && row.q > 0 && row.q <= 1 && /^(zh|en)(-|$)/.test(row.tag))
    .sort((left,right) => right.q-left.q || left.index-right.index);
  return preference === 'zh' || (preference !== 'en' && accepted[0]?.tag.startsWith('zh'));
}`
