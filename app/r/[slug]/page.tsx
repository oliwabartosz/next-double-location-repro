import { cacheLife, cacheTag } from "next/cache";
import { notFound, permanentRedirect } from "next/navigation";

type Result =
  | { kind: "page"; slug: string }
  | { kind: "redirect"; location: string }
  | { kind: "not-found" };

// Stands in for a database read: cached, returns a plain value, never throws.
async function load(slug: string): Promise<Result> {
  "use cache";
  cacheLife("days");
  cacheTag("r", `r:${slug}`);
  if (slug === "__placeholder__") return { kind: "not-found" };
  if (slug.endsWith("-old")) return { kind: "redirect", location: `/r/${slug.slice(0, -4)}` };
  return { kind: "page", slug };
}

// One placeholder param; every real slug is prerendered on its first request.
export function generateStaticParams() {
  return [{ slug: "__placeholder__" }];
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await load(slug);
  if (result.kind === "redirect") permanentRedirect(result.location);
  if (result.kind === "not-found") notFound();
  return <h1>{result.slug}</h1>;
}
