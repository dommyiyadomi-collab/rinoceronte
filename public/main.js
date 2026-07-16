const year = document.querySelector("#year");
if (year) year.textContent = new Date().getFullYear();

const navToggle = document.querySelector(".nav-toggle");
const siteNav = document.querySelector("#site-nav");

if (navToggle && siteNav) {
  const closeNav = () => {
    siteNav.classList.remove("is-open");
    document.body.classList.remove("nav-open");
    navToggle.setAttribute("aria-expanded", "false");
  };

  navToggle.addEventListener("click", () => {
    const isOpen = siteNav.classList.toggle("is-open");
    document.body.classList.toggle("nav-open", isOpen);
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  siteNav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", closeNav);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeNav();
  });
}

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

document.querySelectorAll(".rail-button[aria-controls]").forEach((button) => {
  const rail = document.getElementById(button.getAttribute("aria-controls"));
  if (!rail) return;

  button.addEventListener("click", () => {
    const direction = button.classList.contains("rail-prev") ? -1 : 1;
    rail.scrollBy({
      left: direction * rail.clientWidth * 0.86,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  });
});

document.querySelectorAll(".horizontal-rail").forEach((rail) => {
  rail.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    rail.scrollBy({
      left: direction * rail.clientWidth * 0.72,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  });
});

if ("IntersectionObserver" in window && !prefersReducedMotion) {
  const revealTargets = document.querySelectorAll(
    ".section, .guide-section, .notice-box, .source-box, .content-box, .card, .check-card, .city-profile, .decision-list article",
  );

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
  );

  revealTargets.forEach((target) => {
    target.classList.add("reveal-ready");
    observer.observe(target);
  });
}
