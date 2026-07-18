const formatGuideDate = (date) => new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" }).format(new Date(`${date}T00:00:00Z`));
const createGuideCard = (guide, featured = false) => `
  <article class="guide-card${featured ? " guide-card-featured" : ""}">
    <div class="guide-card-meta"><span class="status-badge">${guide.status}</span><span>${guide.category}</span></div>
    <h3>${guide.title}</h3>
    <p>${guide.description}</p>
    <dl class="guide-meta-list">
      <div><dt>Published</dt><dd><time datetime="${guide.publishedDate}">${formatGuideDate(guide.publishedDate)}</time></dd></div>
      <div><dt>Updated</dt><dd><time datetime="${guide.updatedDate}">${formatGuideDate(guide.updatedDate)}</time></dd></div>
      <div><dt>Read</dt><dd>${guide.readingTime}</dd></div>
    </dl>
    <a class="card-link" href="/guides/${guide.slug}/" aria-label="Read guide: ${guide.title}">View guide</a>
  </article>`;

const renderGuides = () => {
  const categories = window.guideCategories || [];
  const guides = window.guides || [];
  const categoryTarget = document.querySelector("#guide-categories");
  const featuredTarget = document.querySelector("#featured-guide");
  const listTarget = document.querySelector("#guide-list");
  if (categoryTarget) categoryTarget.innerHTML = categories.map((category) => `<span>${category}</span>`).join("");
  if (featuredTarget) {
    const featured = guides.find((guide) => guide.featured) || guides[0];
    featuredTarget.innerHTML = featured ? createGuideCard(featured, true) : '<p class="empty-state">Featured guides will appear here when available.</p>';
  }
  if (listTarget) listTarget.innerHTML = guides.length ? guides.map((guide) => createGuideCard(guide)).join("") : '<p class="empty-state">No guides are available yet. This area is ready for future articles.</p>';
};

document.addEventListener("DOMContentLoaded", renderGuides);
