const { DateTime } = require("luxon");
// breaks:true → un Enter en el CMS se convierte en un salto de línea real en el sitio
const md = require("markdown-it")({ html: false, breaks: true });
const pluginRss = require("@11ty/eleventy-plugin-rss");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPlugin(pluginRss);
  eleventyConfig.addFilter("mdInline", (str) => md.renderInline(str || ""));
  // Para meta tags, RSS y JSON-LD: sin saltos de línea ni markdown
  eleventyConfig.addFilter("oneLine", (str) =>
    (str || "")
      .replace(/\*\*|__|\*|_/g, "")
      .replace(/\s*\n+\s*/g, " ")
      .trim()
  );
  eleventyConfig.addPassthroughCopy({ "src/admin": "admin" });
  eleventyConfig.addPassthroughCopy({ "src/_headers": "_headers" });
  eleventyConfig.addPassthroughCopy({ "src/images": "images" });
  eleventyConfig.addPassthroughCopy({
    "src/favicon/favicon.ico": "favicon.ico",
    "src/favicon/favicon-16x16.png": "favicon-16x16.png",
    "src/favicon/favicon-32x32.png": "favicon-32x32.png",
    "src/favicon/apple-touch-icon.png": "apple-touch-icon.png",
    "src/favicon/icon-192.png": "icon-192.png",
    "src/favicon/icon-512.png": "icon-512.png",
    "src/favicon/site.webmanifest": "site.webmanifest",
  });

  eleventyConfig.addFilter("postDate", (dateObj) => {
    return DateTime.fromJSDate(dateObj, { zone: "utc" }).toFormat("LLL d");
  });

  eleventyConfig.addFilter("postDateFull", (dateObj) => {
    return DateTime.fromJSDate(dateObj, { zone: "utc" }).toFormat("LLL d, yyyy");
  });

  eleventyConfig.addFilter("isoDate", (dateObj) => {
    return DateTime.fromJSDate(dateObj, { zone: "utc" }).toISODate();
  });

  eleventyConfig.addFilter("readTime", (content) => {
    if (!content) return "1 min";
    const words = content.replace(/<[^>]*>/g, " ").trim().split(/\s+/).length;
    const minutes = Math.max(1, Math.round(words / 200));
    return `${minutes} min`;
  });

  eleventyConfig.addFilter("limit", (arr, n) => (arr || []).slice(0, n));

  eleventyConfig.addCollection("posts", (collectionApi) => {
    return collectionApi.getFilteredByGlob("src/posts/*.md").sort((a, b) => b.date - a.date);
  });

  eleventyConfig.addCollection("categories", (collectionApi) => {
    const posts = collectionApi.getFilteredByGlob("src/posts/*.md");
    const seen = new Map();
    posts.forEach((p) => {
      const cat = p.data.category;
      if (cat && !seen.has(cat)) seen.set(cat, p.data.categoryEmoji || "✨");
    });
    return Array.from(seen, ([name, emoji]) => ({ name, emoji }));
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
};
