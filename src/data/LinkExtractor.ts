export class LinkExtractor {
	public extractLinks(body: string): string[] {
		const regex = /:\/([A-Fa-f0-9]{32})/g;
		const links = new Set<string>();
		let match: RegExpExecArray | null;
		while ((match = regex.exec(body)) !== null) {
			links.add(match[1]);
		}
		return Array.from(links);
	}
}
