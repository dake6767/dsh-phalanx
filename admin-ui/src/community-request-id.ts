/** One identity per submitted operation; getRandomValues also works over HTTP. */
export function communityRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
