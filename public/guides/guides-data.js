const guideCategories = [
  "Visa & Legal",
  "Housing",
  "Internet & Work",
  "Cities & Areas",
  "Daily Life",
  "News & Updates",
];

const guides = [
  {
    slug: "japan-digital-nomad-taxes",
    title: "Japan Digital Nomad Taxes",
    description: "A practical guide to tax residence, Japan-source income, treaties, and departure checks for remote workers in Japan.",
    category: "Visa & Legal",
    publishedDate: "2026-07-19",
    updatedDate: "2026-07-19",
    author: "Japan Remote Guide Editorial Team",
    readingTime: "9 min read",
    featuredImage: "/assets/hero-workspace-small.webp",
    status: "Published",
    featured: true,
  },
  {
    slug: "japan-digital-nomad-visa-checklist",
    title: "Japan Digital Nomad Visa: Requirements and Application Checklist",
    description: "A coming-soon guide page for organizing verified visa research before publication.",
    category: "Visa & Legal",
    publishedDate: "2026-07-18",
    updatedDate: "2026-07-18",
    author: "Japan Remote Guide Editorial Team",
    readingTime: "3 min read",
    featuredImage: "",
    status: "Coming Soon",
    featured: false,
  },
  {
    slug: "esim-sim-card-pocket-wifi-japan",
    title: "eSIM, SIM Card or Pocket Wi-Fi: Which Is Best in Japan?",
    description: "A coming-soon guide page for comparing connectivity options after source verification.",
    category: "Internet & Work",
    publishedDate: "2026-07-18",
    updatedDate: "2026-07-18",
    author: "Japan Remote Guide Editorial Team",
    readingTime: "2 min read",
    featuredImage: "",
    status: "Draft",
    featured: false,
  },
  {
    slug: "best-japanese-cities-digital-nomads",
    title: "Best Japanese Cities for Digital Nomads",
    description: "A coming-soon guide page for future city comparisons and verified planning notes.",
    category: "Cities & Areas",
    publishedDate: "2026-07-18",
    updatedDate: "2026-07-18",
    author: "Japan Remote Guide Editorial Team",
    readingTime: "2 min read",
    featuredImage: "",
    status: "Draft",
    featured: false,
  },
];

if (typeof window !== "undefined") {
  window.guideCategories = guideCategories;
  window.guides = guides;
}
