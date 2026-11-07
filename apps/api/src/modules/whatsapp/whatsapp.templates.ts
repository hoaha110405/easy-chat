import { z } from 'zod';
import { type WaTemplate, WhatsAppError } from './whatsapp.types';
export function templatePresentation(t: WaTemplate) {
  const variables: { component: 'header' | 'body'; name: string }[] = [];
  let supported = ['UTILITY', 'MARKETING'].includes(t.category);
  for (const c of t.components) {
    if (c.type === 'FOOTER') continue;
    if (
      !['HEADER', 'BODY'].includes(c.type) ||
      (c.type === 'HEADER' && c.format !== 'TEXT')
    ) {
      supported = false;
      continue;
    }
    const names = [
      ...new Set(
        [...(c.text ?? '').matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    if (
      t.parameter_format !== 'NAMED' &&
      names.some((name, i) => name !== String(i + 1))
    )
      supported = false;
    for (const name of names)
      variables.push({
        component: c.type.toLowerCase() as 'header' | 'body',
        name,
      });
  }
  return {
    ...t,
    supported,
    variables,
    reason: supported ? null : 'WHATSAPP_TEMPLATE_TYPE_UNSUPPORTED',
  };
}
export { whatsappTemplateInputSchema as templateInputSchema } from '@zalo/shared';
import { whatsappTemplateInputSchema as templateInputSchema } from '@zalo/shared';
export function prepareTemplate(
  t: WaTemplate,
  input: z.infer<typeof templateInputSchema>,
) {
  const p = templatePresentation(t);
  if (t.status !== 'APPROVED')
    throw new WhatsAppError('WHATSAPP_TEMPLATE_NOT_APPROVED');
  if (!p.supported)
    throw new WhatsAppError('WHATSAPP_TEMPLATE_TYPE_UNSUPPORTED');
  if (
    t.id !== input.templateId ||
    t.name !== input.templateName ||
    t.language !== input.language ||
    p.variables.length !== input.parameters.length
  )
    throw new WhatsAppError('WHATSAPP_TEMPLATE_PARAMETERS_INVALID');
  const components = [];
  for (const component of ['header', 'body'] as const) {
    const variables = p.variables.filter((v) => v.component === component);
    if (!variables.length) continue;
    const parameters = variables.map((v) => {
      const matches = input.parameters.filter(
        (x) => x.component === component && x.name === v.name,
      );
      if (matches.length !== 1)
        throw new WhatsAppError('WHATSAPP_TEMPLATE_PARAMETERS_INVALID');
      return {
        type: 'text',
        text: matches[0].value,
        ...(t.parameter_format === 'NAMED' ? { parameter_name: v.name } : {}),
      };
    });
    components.push({ type: component, parameters });
  }
  let content = t.components
    .filter((c) => ['HEADER', 'BODY', 'FOOTER'].includes(c.type))
    .map((c) => {
      let text = c.text ?? '';
      for (const v of input.parameters.filter(
        (v) => v.component === c.type.toLowerCase(),
      ))
        text = text.split('{{' + v.name + '}}').join(v.value);
      return text;
    })
    .filter(Boolean)
    .join('\n');
  if (!content) content = `[${t.name} · ${t.language}]`;
  return {
    content,
    payload: {
      type: 'template',
      template: {
        name: t.name,
        language: { code: t.language },
        ...(components.length ? { components } : {}),
      },
    },
  };
}
