export function pageKey(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (!url.hash.startsWith('#/') && !url.hash.startsWith('#!')) url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm|vd_source|ref_)|^(from|ref)$/.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch {
    return raw.trim();
  }
}
export function isReadableUrl(url?: string): boolean {
  return !!url && /^https?:\/\//.test(url) && !/^https:\/\/chromewebstore\.google\.com\//.test(url);
}
