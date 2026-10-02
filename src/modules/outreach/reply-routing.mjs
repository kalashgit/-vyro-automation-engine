// Temporary reply routing until the domain's incoming mail is operational.
// Configure through environment; never change MX records for Reply-To.
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export function getVyroReplyTo(environment = process.env) {
  const address = environment.VYRO_REPLY_TO?.trim();
  if (!address || !EMAIL.test(address) || address.length > 254) throw new Error('VYRO_REPLY_TO must be configured with one valid email address');
  return address;
}
export function addReplyRouting(payload, environment = process.env) {
  return { ...payload, reply_to: getVyroReplyTo(environment) };
}
