// Entradas, cambio de imagen del panel fijo, galería arrastrable y newsletter.
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Entradas: cada bloque [data-reveal] aparece una vez al entrar en pantalla
  var reveals = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  // Panel fijo: la imagen cambia cuando llega su sección
  var imgs = document.querySelectorAll('[data-stage-img]');
  var sections = document.querySelectorAll('[data-stage]');
  if (imgs.length > 1 && sections.length && 'IntersectionObserver' in window) {
    var show = function (n) {
      imgs.forEach(function (img) { img.classList.toggle('is-on', img.getAttribute('data-stage-img') === n); });
    };
    var so = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) show(e.target.getAttribute('data-stage')); });
    }, { rootMargin: '-45% 0px -45% 0px' });
    sections.forEach(function (s) { so.observe(s); });
  }

  // Galería: arrastrar con el mouse
  document.querySelectorAll('.gallery__row').forEach(function (row) {
    var down = false, startX = 0, startLeft = 0, moved = false;
    row.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse') return;
      down = true; moved = false; startX = e.clientX; startLeft = row.scrollLeft;
    });
    window.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - startX;
      if (Math.abs(dx) > 4) { moved = true; row.classList.add('is-dragging'); }
      row.scrollLeft = startLeft - dx;
    });
    window.addEventListener('pointerup', function () { down = false; row.classList.remove('is-dragging'); });
    row.addEventListener('click', function (e) { if (moved) { e.preventDefault(); moved = false; } }, true);
  });

  // Newsletter (Netlify Forms) sin salir de la página
  document.querySelectorAll('form[data-nl]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var done = form.querySelector('[data-nl-done]');
      var err = form.querySelector('[data-nl-error]');
      err.hidden = true;
      fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)).toString()
      }).then(function (res) {
        if (!res.ok) throw new Error(res.status);
        form.querySelector('.nl__row').hidden = true;
        form.querySelector('.nl__label').hidden = true;
        done.hidden = false;
      }).catch(function () { err.hidden = false; });
    });
  });
})();
