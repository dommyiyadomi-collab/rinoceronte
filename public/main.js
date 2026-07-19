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

const cityComparisonData = {
  tokyo: {
    name: "Tokyo",
    label: "Maximum convenience",
    tagline: "For high-end convenience, meetings, events, and first-time confidence.",
    matchCopy:
      "Maximum convenience, deep transit, and the widest workspace backup network make Tokyo the safest first choice when meetings cannot fail.",
    caution: "housing cost is the main constraint",
    bestFor: "First-time confidence, meetings, events.",
    workSetup: "Deep coworking, cafes, hotels, transit, and international services.",
    firstBase: "Stay near a rail hub with multiple workspace backups.",
    watchOut: "Do not let convenience hide housing cost and neighborhood friction.",
  },
  osaka: {
    name: "Osaka",
    label: "Balanced city base",
    tagline: "For big-city practicality with a slightly more relaxed operating rhythm.",
    matchCopy:
      "Osaka keeps the big-city infrastructure while reducing some of Tokyo's intensity, with excellent access across Kansai.",
    caution: "you need a clearly packaged nomad scene",
    bestFor: "Balanced city life and Kansai side trips.",
    workSetup: "Strong urban infrastructure and easy regional travel across Kansai.",
    firstBase: "Choose Umeda, Namba, or a direct route to your primary workspace.",
    watchOut: "Choose around transit and workspace access, not only nightlife or sightseeing.",
  },
  fukuoka: {
    name: "Fukuoka",
    label: "Community and livability",
    tagline: "For community, livability, and a compact daily loop.",
    matchCopy:
      "Fukuoka is the best fit when you want compact city life, friendlier landing friction, and a clearer nomad-community signal.",
    caution: "you need constant global-scale events",
    bestFor: "Community, livability, compact routines.",
    workSetup: "Compact city layout, coworking options, airport access, and short local travel times.",
    firstBase: "Choose Hakata or Tenjin for easy first-week logistics.",
    watchOut: "Tokyo still has the deeper global-scale event pool.",
  },
  kyoto: {
    name: "Kyoto",
    label: "Culture and slow rhythm",
    tagline: "For culture-focused slow stays and deep work in a beautiful setting.",
    matchCopy:
      "Kyoto works best for deep work and culture-led routines when you secure a proper workspace before relying on cafes.",
    caution: "peak-season crowds would disrupt your workday",
    bestFor: "Deep work, culture, slower routines.",
    workSetup: "Good for writers, designers, researchers, and slow-travel workers who do not need constant events.",
    firstBase: "Choose transit and workspace access over postcard views.",
    watchOut: "Cafe work etiquette matters. Have a proper workspace backup.",
  },
  sapporo: {
    name: "Sapporo",
    label: "Nature and space",
    tagline: "For seasonal stays, space, winter sports, and nature access with city basics.",
    matchCopy:
      "Sapporo is strongest when the season is part of the plan: snow, space, mountains, and an urban base for Hokkaido.",
    caution: "you need fast access across Japan every week",
    bestFor: "Winter, nature access, spacious seasonal work.",
    workSetup: "Sapporo gives the most reliable urban base before exploring wider Hokkaido.",
    firstBase: "Stay in Sapporo first, then explore wider Hokkaido from a stable base.",
    watchOut: "Winter logistics, weather, and distance can change your daily productivity plan.",
  },
  okinawa: {
    name: "Okinawa",
    label: "Warm slowmad stay",
    tagline: "For warm-weather slow living, recovery time, and nature-led routines.",
    matchCopy:
      "Okinawa fits flexible workers who want warmth and slower living, with Wi-Fi, transport, and typhoon backup checked first.",
    caution: "calls and transport must be predictable every day",
    bestFor: "Warm slow living, recovery time, sea access.",
    workSetup: "Works best when you pre-check Wi-Fi, workspace, and transport around your exact neighborhood.",
    firstBase: "Start in Naha or a verified coliving/work setup before going remote.",
    watchOut: "Typhoon season, car dependence, and peak pricing can break a casual plan.",
  },
};

const cityKeys = Object.keys(cityComparisonData);

const cityMatchWeights = {
  stay: {
    short: { tokyo: 4, osaka: 3, kyoto: 2, fukuoka: 2, sapporo: 1, okinawa: 1 },
    month: { fukuoka: 4, osaka: 3, tokyo: 2, kyoto: 2, sapporo: 2, okinawa: 1 },
    seasonal: { sapporo: 4, okinawa: 3, fukuoka: 2, kyoto: 2, osaka: 1, tokyo: 1 },
  },
  priority: {
    convenience: { tokyo: 4, osaka: 3, fukuoka: 2, kyoto: 1, sapporo: 1, okinawa: 0 },
    budget: { fukuoka: 4, sapporo: 3, osaka: 3, okinawa: 2, kyoto: 1, tokyo: 0 },
    community: { fukuoka: 4, tokyo: 3, osaka: 2, kyoto: 2, okinawa: 1, sapporo: 1 },
    "deep-work": { kyoto: 4, sapporo: 3, fukuoka: 2, okinawa: 2, osaka: 1, tokyo: 1 },
  },
  calls: {
    critical: { tokyo: 4, osaka: 3, fukuoka: 3, kyoto: 2, sapporo: 2, okinawa: 0 },
    normal: { osaka: 3, fukuoka: 3, tokyo: 3, kyoto: 2, sapporo: 2, okinawa: 1 },
    flexible: { okinawa: 4, sapporo: 3, kyoto: 3, fukuoka: 2, osaka: 1, tokyo: 1 },
  },
  movement: {
    "car-free": { tokyo: 4, osaka: 3, fukuoka: 3, kyoto: 2, sapporo: 2, okinawa: 0 },
    regional: { osaka: 4, tokyo: 3, fukuoka: 3, kyoto: 2, sapporo: 1, okinawa: 0 },
    local: { fukuoka: 4, kyoto: 3, okinawa: 3, sapporo: 2, osaka: 2, tokyo: 1 },
  },
  season: {
    any: { tokyo: 3, osaka: 3, fukuoka: 3, kyoto: 2, sapporo: 2, okinawa: 1 },
    warm: { okinawa: 4, fukuoka: 3, osaka: 2, tokyo: 1, kyoto: 1, sapporo: 0 },
    winter: { sapporo: 4, tokyo: 2, osaka: 2, kyoto: 2, fukuoka: 1, okinawa: 0 },
    stable: { tokyo: 4, osaka: 3, fukuoka: 3, kyoto: 2, sapporo: 1, okinawa: 0 },
  },
};

const getCheckedValue = (form, name) => {
  const checked = form.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : "";
};

const getCityMatchCaution = (form, bestKey) => {
  const stay = getCheckedValue(form, "stay");
  const priority = getCheckedValue(form, "priority");
  const calls = getCheckedValue(form, "calls");
  const movement = getCheckedValue(form, "movement");
  const season = getCheckedValue(form, "season");

  if (calls === "critical" && bestKey === "okinawa") {
    return "calls cannot tolerate area-by-area Wi-Fi or storm uncertainty";
  }
  if (movement === "car-free" && bestKey === "okinawa") {
    return "you stay outside central areas without a mobility backup";
  }
  if (season === "winter" && bestKey !== "sapporo") {
    return "snow access is the main reason for choosing the season";
  }
  if (season === "winter" && bestKey === "sapporo") {
    return "snow is the appeal, but winter logistics must fit your workday";
  }
  if (season === "warm" && bestKey !== "okinawa" && bestKey !== "fukuoka") {
    return "warm weather is more important than big-city convenience";
  }
  if (season === "warm" && bestKey === "okinawa") {
    return "typhoon timing and exact neighborhood reliability need checking";
  }
  if (season === "stable" && bestKey === "sapporo") {
    return "winter logistics would reduce your daily predictability";
  }
  if (movement === "regional" && bestKey === "osaka") {
    return "regional trips should not crowd protected workdays";
  }
  if (priority === "budget" && bestKey === "tokyo") {
    return "housing cost is the main constraint";
  }
  if (stay === "seasonal" && bestKey === "tokyo") {
    return "you want the season itself to shape the stay";
  }

  return cityComparisonData[bestKey].caution;
};

const updateCityMatcher = (matcher) => {
  const form = matcher.querySelector(".city-preferences");
  if (!form) return;

  const scores = Object.fromEntries(cityKeys.map((city) => [city, 0]));
  Object.entries(cityMatchWeights).forEach(([name, options]) => {
    const weights = options[getCheckedValue(form, name)] || {};
    cityKeys.forEach((city) => {
      scores[city] += weights[city] || 0;
    });
  });

  const ranked = cityKeys.slice().sort((a, b) => scores[b] - scores[a]);
  const best = cityComparisonData[ranked[0]];
  const alternative = cityComparisonData[ranked[1]];

  matcher.querySelector("[data-match-city]").textContent = best.name;
  matcher.querySelector("[data-match-copy]").textContent = best.matchCopy;
  matcher.querySelector("[data-match-alternative]").textContent = alternative.name;
  matcher.querySelector("[data-match-caution]").textContent = getCityMatchCaution(form, ranked[0]);
};

document.querySelectorAll("[data-city-matcher]").forEach((matcher) => {
  const form = matcher.querySelector(".city-preferences");
  if (!form) return;
  form.addEventListener("change", () => updateCityMatcher(matcher));
  updateCityMatcher(matcher);
});

const appendDefinition = (list, term, description) => {
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = description;
  row.append(dt, dd);
  list.append(row);
};

const createVersusCard = (city) => {
  const card = document.createElement("article");
  card.className = "versus-card";

  const label = document.createElement("span");
  label.className = "check-label";
  label.textContent = city.label;

  const title = document.createElement("h3");
  title.textContent = city.name;

  const copy = document.createElement("p");
  copy.textContent = city.tagline;

  const list = document.createElement("dl");
  appendDefinition(list, "Best for", city.bestFor);
  appendDefinition(list, "Work setup", city.workSetup);
  appendDefinition(list, "First base", city.firstBase);
  appendDefinition(list, "Watch-out", city.watchOut);

  card.append(label, title, copy, list);
  return card;
};

document.querySelectorAll("[data-city-versus]").forEach((versus) => {
  const firstSelect = versus.querySelector("[data-compare-a]");
  const secondSelect = versus.querySelector("[data-compare-b]");
  const output = versus.querySelector("[data-city-compare-output]");
  if (!firstSelect || !secondSelect || !output) return;

  const syncCityOptions = () => {
    Array.from(firstSelect.options).forEach((option) => {
      option.disabled = option.value === secondSelect.value;
    });
    Array.from(secondSelect.options).forEach((option) => {
      option.disabled = option.value === firstSelect.value;
    });
  };

  const updateVersus = () => {
    if (firstSelect.value === secondSelect.value) {
      const replacement = cityKeys.find((city) => city !== firstSelect.value);
      secondSelect.value = replacement || "fukuoka";
    }
    syncCityOptions();
    const first = cityComparisonData[firstSelect.value] || cityComparisonData.tokyo;
    const second = cityComparisonData[secondSelect.value] || cityComparisonData.fukuoka;
    output.replaceChildren(createVersusCard(first), createVersusCard(second));
  };

  firstSelect.addEventListener("change", updateVersus);
  secondSelect.addEventListener("change", updateVersus);
  updateVersus();
});

document.querySelectorAll(".city-profile img").forEach((image) => {
  if (typeof image.decode !== "function") return;
  image.decode().catch(() => {});
});

if ("IntersectionObserver" in window && !prefersReducedMotion) {
  const revealTargets = document.querySelectorAll(
    ".section, .guide-section, .about-section, .notice-box, .source-box, .content-box, .card, .check-card, .city-profile, .decision-list article, .city-match-result, .versus-card, .founder-card, .business-card, .about-card, .source-card, .contact-panel",
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

const scrollProgressBar = document.querySelector("#scroll-progress-bar");
if (scrollProgressBar) {
  const updateScrollProgress = () => {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const progress = maxScroll > 0 ? (window.scrollY / maxScroll) * 100 : 0;
    scrollProgressBar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
  };

  updateScrollProgress();
  document.addEventListener("scroll", updateScrollProgress, { passive: true });
  window.addEventListener("resize", updateScrollProgress);
}
