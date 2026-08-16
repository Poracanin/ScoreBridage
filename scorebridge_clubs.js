(() => {
  const clubs = [
    {
      name: 'AFK Tuchlovice',
      slug: 'AFKTuchlovice',
      address: 'Za Starou poštou 646, 273 02 Tuchlovice',
      coords: [50.140817, 13.9841848],
      maker: 'VšeProfiFotbal',
      controller: 'Rádiový · 6 prvků',
      frequency: 'K ověření',
      frequencyClass: 'is-pending',
      note: 'Na tabuli je uveden dodavatel; výrobní štítek ani frekvence na fotografii nejsou.',
      board: 'AFKTuchlovice-tabule.webp',
      remote: 'AFKTuchlovice-ovladac.webp',
      extras: []
    },
    {
      name: 'FK Slovan Kladno',
      slug: 'FKSlovanKladno',
      address: 'Sportovců 695, 272 04 Kladno',
      coords: [50.1372575, 14.084666],
      maker: 'SportFotbal',
      controller: 'LDP · 4 tlačítka',
      frequency: 'K ověření',
      frequencyClass: 'is-pending',
      note: 'Řada LDP je určena podle ovladače a označení dodavatele; přesný model ani RF pásmo nejsou uvedeny.',
      board: 'FKSlovanKladno-tabule.webp',
      remote: 'FKSlovanKladno-ovladac.webp',
      extras: []
    },
    {
      name: 'SK Lhota',
      slug: 'SKLhota',
      address: 'Žilina 11, 273 01 Žilina',
      coords: [50.0923056, 14.0076033],
      maker: 'LEGGA',
      controller: 'Kabelový pult',
      frequency: 'Bez RF',
      frequencyClass: 'is-wired',
      note: '',
      board: 'SKLhota-tabule.webp',
      remote: 'SKLhota-ovladac.webp',
      extras: [
        ['SKLhota-tabule-detail.webp', 'SK Lhota — detail výsledkové tabule']
      ]
    },
    {
      name: 'SK Slavoj Pozdeň',
      slug: 'SKSlavojPozden',
      address: 'Pozdeň 153, 273 76 Pozdeň',
      coords: [50.2412978, 13.9395586],
      maker: 'EAL/TIA',
      controller: 'DERBY RC',
      frequency: '433,87 MHz',
      frequencyClass: 'is-confirmed',
      note: 'Profil této rodiny DERBY RC byl změřen při RF testování ScoreBridge.',
      noteClass: 'is-confirmed',
      board: 'SKSlavojPozden-tabule.webp',
      remote: 'SKSlavojPozden-ovladac.webp',
      extras: [
        ['SKSlavojPozden-tabule-zadni.webp', 'SK Slavoj Pozdeň — zadní strana tabule'],
        ['SKSlavojPozden-ovladac-zadni.webp', 'SK Slavoj Pozdeň — zadní strana ovladače'],
        ['SKSlavojPozden-ovladac-detail.webp', 'SK Slavoj Pozdeň — detail ovladače']
      ]
    },
    {
      name: 'SK Velké Přítočno',
      slug: 'SKVelkePritocno',
      address: 'Školní 239, 273 51 Velké Přítočno',
      coords: [50.1135816, 14.1282701],
      maker: 'EAL/TIA',
      controller: 'DERBY RC',
      frequency: '433,87 MHz',
      frequencyClass: 'is-confirmed',
      note: 'Profil této rodiny DERBY RC byl změřen při RF testování ScoreBridge.',
      noteClass: 'is-confirmed',
      board: 'SKVelkePritocno-tabule.webp',
      remote: 'SKVelkePritocno-ovladac.webp',
      extras: []
    },
    {
      name: 'TJ Sokol Olovnice',
      slug: 'TJSokolOlovnice',
      address: 'U Hřiště 70, 273 26 Olovnice',
      coords: [50.2368336, 14.2416919],
      maker: 'EAL/TIA',
      controller: 'DERBY RC',
      frequency: '433,87 MHz',
      frequencyClass: 'is-confirmed',
      note: 'Profil této rodiny DERBY RC byl změřen při RF testování ScoreBridge.',
      noteClass: 'is-confirmed',
      board: 'TJSokolOlovnice-tabule.webp',
      remote: 'TJSokolOlovnice-ovladac.webp',
      extras: []
    },
    {
      name: 'TJ Unhošť',
      slug: 'TJUnhost',
      address: 'Smetanova 154, 273 51 Unhošť',
      coords: [50.0880169, 14.1264862],
      maker: 'TRV elektronik',
      controller: 'OS2010 · 6 tlačítek',
      frequency: 'K ověření',
      frequencyClass: 'is-pending',
      note: 'Model OS2010 je potvrzen štítkem. Fotografie elektroniky neobsahuje čitelné označení RF pásma.',
      board: 'TJUnhost-tabule.webp',
      remote: 'TJUnhost-ovladac.webp',
      extras: [
        ['TJUnhost-ovladac-detail.webp', 'TJ Unhošť — detail ovladače'],
        ['TJUnhost-ovladac-zadni.webp', 'TJ Unhošť — štítek ovladače OS2010'],
        ['TJUnhost-ovladac-zadni-2.webp', 'TJ Unhošť — zadní strana ovladače'],
        ['TJUnhost-ovladac-vnitrni-1.webp', 'TJ Unhošť — elektronika ovladače'],
        ['TJUnhost-ovladac-vnitrni-2.webp', 'TJ Unhošť — vnitřní strana klávesnice'],
        ['TJUnhost-tabule-konektory-1.webp', 'TJ Unhošť — konektory tabule 1'],
        ['TJUnhost-tabule-konektory-2.webp', 'TJ Unhošť — konektory tabule 2'],
        ['TJUnhost-tabule-konektory-3.webp', 'TJ Unhošť — konektory tabule 3'],
        ['TJUnhost-ovladac-test-1.webp', 'TJ Unhošť — test ovladače 1'],
        ['TJUnhost-ovladac-test-2.webp', 'TJ Unhošť — test ovladače 2'],
        ['TJUnhost-ovladac-test-3.webp', 'TJ Unhošť — test ovladače 3']
      ]
    }
  ];

  const grid = document.getElementById('clubsGrid');
  const empty = document.getElementById('clubsEmpty');
  const search = document.getElementById('clubSearch');
  const topSearch = document.getElementById('clubSearchTop');
  const lightbox = document.getElementById('clubLightbox');
  const lightboxImage = document.getElementById('clubLightboxImage');
  const lightboxCaption = document.getElementById('clubLightboxCaption');
  const lightboxClose = document.getElementById('clubLightboxClose');
  let lastFocusedImage = null;

  const imagePath = (club, file) => `kluby/${club.slug}/${file}`;
  const normalize = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('cs-CZ')
    .trim();

  function photoButton(club, file, caption, label) {
    const path = imagePath(club, file);
    return `<button class="club-photo" type="button" data-club-image="${path}" data-club-caption="${caption}">
      <img src="${path}" alt="${caption}" loading="lazy" decoding="async">
      <span>${label}</span>
    </button>`;
  }

  function galleryMarkup(club) {
    if (!club.extras.length) return '';
    const title = club.slug === 'TJUnhost' ? 'Technické detaily' : 'Další fotografie';
    const buttons = club.extras.map(([file, caption]) => {
      const path = imagePath(club, file);
      return `<button type="button" data-club-image="${path}" data-club-caption="${caption}"><img src="${path}" alt="${caption}" loading="lazy" decoding="async"></button>`;
    }).join('');
    return `<details class="club-gallery"><summary>${title} <span>${club.extras.length}</span></summary><div>${buttons}</div></details>`;
  }

  function renderCards() {
    if (!grid) return;
    grid.innerHTML = clubs.map(club => {
      const searchable = [club.name, club.slug, club.address, club.maker, club.controller, club.frequency].join(' ');
      return `<article class="club-card" data-club-card data-search="${searchable}">
        <header class="club-card-head">
          <div><span>OP Kladno</span><h3>${club.name}</h3></div>
          <code>${club.slug}</code>
        </header>
        <div class="club-media">
          ${photoButton(club, club.board, `${club.name} — výsledková tabule`, 'Tabule')}
          ${photoButton(club, club.remote, `${club.name} — ovladač`, 'Ovladač')}
        </div>
        <p class="club-address"><span aria-hidden="true">⌖</span>${club.address}</p>
        <dl class="club-specs">
          <div><dt>Frekvence</dt><dd><span class="club-frequency ${club.frequencyClass}">${club.frequency}</span></dd></div>
          <div><dt>Výrobce / dodavatel</dt><dd>${club.maker}</dd></div>
          <div><dt>Typ ovladače</dt><dd>${club.controller}</dd></div>
        </dl>
        ${club.note ? `<p class="club-note ${club.noteClass || ''}">${club.note}</p>` : ''}
        ${galleryMarkup(club)}
      </article>`;
    }).join('');
  }

  function filterClubs(value) {
    const query = normalize(value);
    let visible = 0;
    document.querySelectorAll('[data-club-card]').forEach(card => {
      const match = !query || normalize(card.dataset.search).includes(query) || normalize(card.textContent).includes(query);
      card.hidden = !match;
      if (match) visible += 1;
    });
    if (empty) empty.hidden = visible !== 0;
  }

  function syncSearch(source, target) {
    if (target && target.value !== source.value) target.value = source.value;
    filterClubs(source.value);
  }

  function openLightbox(trigger) {
    if (!lightbox || !lightboxImage || !lightboxCaption) return;
    const source = trigger.dataset.clubImage;
    const caption = trigger.dataset.clubCaption || trigger.querySelector('img')?.alt || 'Fotografie klubu';
    if (!source) return;
    lastFocusedImage = trigger;
    lightboxImage.src = source;
    lightboxImage.alt = caption;
    lightboxCaption.textContent = caption;
    lightbox.classList.add('is-open');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.classList.add('club-lightbox-open');
    lightboxClose?.focus();
  }

  function closeLightbox() {
    if (!lightbox?.classList.contains('is-open')) return;
    lightbox.classList.remove('is-open');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('club-lightbox-open');
    lightboxImage.removeAttribute('src');
    lastFocusedImage?.focus();
  }

  function initializeMap() {
    const mapElement = document.getElementById('clubsMap');
    if (!mapElement) return;
    if (!window.L) {
      mapElement.innerHTML = '<div class="clubs-map-fallback">Mapu se nepodařilo načíst. Adresy klubů jsou uvedené u jednotlivých karet.</div>';
      return;
    }
    mapElement.innerHTML = '';
    const map = L.map(mapElement, { scrollWheelZoom: false, zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    const markerIcon = L.divIcon({
      className: 'club-map-marker-wrap',
      html: '<span class="club-map-marker"></span>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      popupAnchor: [0, -10]
    });
    const bounds = [];
    clubs.forEach(club => {
      bounds.push(club.coords);
      L.marker(club.coords, { icon: markerIcon, title: club.name })
        .addTo(map)
        .bindPopup(`<div class="club-map-popup"><h3>${club.name}</h3><p>${club.address}</p><span>V přípravě</span></div>`);
    });
    map.fitBounds(bounds, { padding: [36, 36], maxZoom: 11 });
    window.setTimeout(() => map.invalidateSize(), 100);
  }

  function initializeSidebar() {
    const toggle = document.getElementById('sidebarToggle');
    const close = document.getElementById('mobileMenuClose');
    const scrim = document.getElementById('sidebarScrim');
    const mobile = window.matchMedia('(max-width:700px)');
    let desktopHidden = false;
    const render = () => {
      document.body.classList.toggle('sidebar-collapsed', !mobile.matches && desktopHidden);
      if (!mobile.matches) document.body.classList.remove('sidebar-open');
      const isOpen = mobile.matches ? document.body.classList.contains('sidebar-open') : !desktopHidden;
      toggle?.setAttribute('aria-expanded', String(isOpen));
      const label = toggle?.querySelector('.sidebar-toggle-label');
      if (label) label.textContent = isOpen ? 'Skrýt nabídku' : 'Zobrazit nabídku';
    };
    const closeMenu = () => {
      document.body.classList.remove('sidebar-open');
      render();
    };
    toggle?.addEventListener('click', () => {
      if (mobile.matches) document.body.classList.toggle('sidebar-open');
      else desktopHidden = !desktopHidden;
      render();
    });
    close?.addEventListener('click', closeMenu);
    scrim?.addEventListener('click', closeMenu);
    mobile.addEventListener?.('change', render);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) closeMenu();
    });
    render();
  }

  renderCards();
  search?.addEventListener('input', () => syncSearch(search, topSearch));
  topSearch?.addEventListener('input', () => syncSearch(topSearch, search));
  document.querySelectorAll('[data-club-image]').forEach(trigger => {
    trigger.addEventListener('click', () => openLightbox(trigger));
  });
  lightboxClose?.addEventListener('click', closeLightbox);
  lightbox?.addEventListener('click', event => {
    if (event.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && lightbox?.classList.contains('is-open')) closeLightbox();
  });

  initializeMap();
  initializeSidebar();
})();
