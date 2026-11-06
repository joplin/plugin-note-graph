export interface Note {
	id: string;
	parent_id: string;
	title: string;
	/** The full body when fetched; cut to an excerpt once preprocessed. */
	body: string;
	created_time: number;
	updated_time: number;
	links?: string[];
	tags?: string[];
}
