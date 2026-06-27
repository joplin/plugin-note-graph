const resourceRegex = /^(joplin:\/\/|:\/)([A-Fa-f0-9]{32})(|#[^\s]*)(|\s".*?")$/;

const urlDecode = (s: string): string =>
	decodeURIComponent(s.replace(/\+/g, ' '));

/** Checks if a URL string matches the Joplin resource format (:/id or joplin://id). */
export const isResourceUrl = (url: string): boolean =>
	!!url.match(resourceRegex);

/** Splits a Joplin resource URL into its itemId and optional anchor hash. Returns null for invalid URLs. */
export const parseResourceUrl = (url: string): { itemId: string; hash: string } | null => {
	if (!isResourceUrl(url)) return null;

	const match = url.match(resourceRegex)!;
	const itemId = match[2];
	let hash = match[3].trim();
	if (hash) hash = urlDecode(hash.substring(1));

	return { itemId, hash };
};

const stripCodeRegions = (text: string): string =>
	text
		.replace(/```[\s\S]*?```/g, '')
		.replace(/`[^`]+`/g, '');

/** Scans markdown/HTML text and pulls out all Joplin resource links (:/id) with their optional hash anchors. Skips code blocks and inline code. */
export const extractResourceUrls = (text: string): { itemId: string; hash: string }[] => {
	const cleaned = stripCodeRegions(text);

	const markdownLinkRegexes = [
		/(?<!\\)\]\((.*?)(?<!\\)\)/g,
		/(?<!\\)\]:(.*?)(?:[\n]|$)/g,
	];

	const output: { itemId: string; hash: string }[] = [];
	let result = null;

	for (const regex of markdownLinkRegexes) {
		while ((result = regex.exec(cleaned)) !== null) {
			const resourceUrlInfo = parseResourceUrl(result[1].trim());
			if (resourceUrlInfo) output.push(resourceUrlInfo);
		}
	}

	const htmlLinkRegex = /<(?:img|a)\s[\s\S]*?(?:src|href)=["']((?:joplin:\/\/|:\/)[A-Fa-f0-9]{32}(?:#[^"'\s]*)?)["'][\s\S]*?>/gi;

	let m: RegExpExecArray | null;
	while ((m = htmlLinkRegex.exec(cleaned)) !== null) {
		const resourceUrlInfo = parseResourceUrl(m[1]);
		if (resourceUrlInfo) output.push(resourceUrlInfo);
	}

	return output;
};

export class LinkExtractor {
	/** Returns unique note/resource IDs linked from a note body. */
	public extractLinks(body: string): string[] {
		return [...new Set(extractResourceUrls(body).map((r) => r.itemId))];
	}
}
