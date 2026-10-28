import { DOCS_SLUGS, docsPath } from "./docs";
import { GITHUB_URL } from "./site";

/** Repo docs link to each other as `./name.md`; on the site those become pages, or GitHub when unpublished. */
export function rewriteDocsLinks(markdown: string): string {
  return markdown.replace(/\]\(\.\/([\w-]+)\.md(#[^)]*)?\)/g, (_, slug: string, hash = "") =>
    DOCS_SLUGS.includes(slug)
      ? `](${docsPath(slug)}${hash})`
      : `](${GITHUB_URL}/blob/main/docs/${slug}.md${hash})`,
  );
}
