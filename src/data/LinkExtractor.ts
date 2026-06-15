const resourceRegex = /^(joplin:\/\/|:\/)([A-Fa-f0-9]{32})(|#[^\s]*)(|\s".*?")$/;

const urlDecode = (s: string): string =>
	decodeURIComponent(s.replace(/\+/g, ' '));

export const isResourceUrl = (url: string): boolean =>
	!!url.match(resourceRegex);

export const parseResourceUrl = (url: string): { itemId: string; hash: string } | null => {
	if (!isResourceUrl(url)) return null;

	const match = url.match(resourceRegex)!;
	const itemId = match[2];
	let hash = match[3].trim();
	if (hash) hash = urlDecode(hash.substring(1));

	return { itemId, hash };
};

export const extractResourceUrls = (text: string): { itemId: string; hash: string }[] => {
	const markdownLinkRegexes = [
		/\]\((.*?)\)/g,
		/\]:(.*?)(?:[\n]|$)/g,
	];

	const output: { itemId: string; hash: string }[] = [];
	let result = null;

	for (const regex of markdownLinkRegexes) {
		while ((result = regex.exec(text)) !== null) {
			const resourceUrlInfo = parseResourceUrl(result[1].trim());
			if (resourceUrlInfo) output.push(resourceUrlInfo);
		}
	}

	const htmlRegexes = [
		/<img[\s\S]*?src=["']:\/([A-Fa-f0-9]{32})["'][\s\S]*?>/gi,
		/<a[\s\S]*?href=["']:\/([A-Fa-f0-9]{32})["'][\s\S]*?>/gi,
	];

	for (const htmlRegex of htmlRegexes) {
		while (true) {
			const m = htmlRegex.exec(text);
			if (!m) break;
			output.push({ itemId: m[1], hash: '' });
		}
	}

	return output;
};

export class LinkExtractor {
	public extractLinks(body: string): string[] {
		return [...new Set(extractResourceUrls(body).map((r) => r.itemId))];
	}
}
