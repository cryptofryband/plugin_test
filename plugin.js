/**
 * Lampa Plugin — Смотреть онлайн через kinopoisk.cx
 * Версия: 3.0.0
 *
 * 1. В карточке фильма появляется кнопка "Смотреть онлайн"
 * 2. По нажатию — выезжающий список: "Kinopoisk.cx" и "Online Mod" (если установлен)
 * 3. Для kinopoisk.cx ID Кинопоиска берётся из карточки, из кэша или через
 *    kinopoiskapiunofficial.tech (по imdb_id, затем по названию и году)
 * 4. Токен НЕ хранится в коде — плагин один раз спросит его и запомнит в Lampa.Storage
 */
(function () {
  'use strict';

  if (typeof Lampa === 'undefined') return;
  if (window.online_cinema_kp_loaded) return;
  window.online_cinema_kp_loaded = true;

  var TAG = '[OnlineCinema]';

  // ========== НАСТРОЙКИ ==========
  var Settings = {
    domain: function () {
      return Lampa.Storage.get('oc_domain', 'kinopoisk.cx');
    },
    token: function () {
      return Lampa.Storage.get('oc_kp_token', '');
    }
  };

  // ========== ПОИСК KINOPOISK ID ==========
  var KP = {
    network: new Lampa.Reguest(),

    fromCard: function (movie) {
      return movie.kinopoisk_id || movie.kp_id ||
        (movie.external_ids && (movie.external_ids.kinopoisk_id || movie.external_ids.kp_id)) ||
        null;
    },

    cacheKey: function (movie) {
      return movie.imdb_id ||
        (movie.external_ids && movie.external_ids.imdb_id) ||
        'tmdb' + movie.id;
    },

    fromCache: function (movie) {
      var cache = Lampa.Storage.get('oc_kp_cache', {}) || {};
      return cache[this.cacheKey(movie)] || null;
    },

    toCache: function (movie, id) {
      var cache = Lampa.Storage.get('oc_kp_cache', {}) || {};
      cache[this.cacheKey(movie)] = id;
      Lampa.Storage.set('oc_kp_cache', cache);
    },

    fromApi: function (movie, done) {
      var token = Settings.token();
      if (!token) return done(null);

      var imdb = movie.imdb_id || (movie.external_ids && movie.external_ids.imdb_id);
      var title = movie.title || movie.name || '';
      var date = movie.release_date || movie.first_air_date || '';
      var year = date ? parseInt(date.slice(0, 4), 10) : 0;
      var base = 'https://kinopoiskapiunofficial.tech/api/v2.2/films?';
      var params = { headers: { 'X-API-KEY': token, 'Content-Type': 'application/json' } };
      var self = this;

      function byTitle() {
        if (!title) return done(null);
        var url = base + 'keyword=' + encodeURIComponent(title);
        if (year) url += '&yearFrom=' + (year - 1) + '&yearTo=' + (year + 1);
        self.network.silent(url, function (json) {
          var item = json && json.items && json.items[0];
          done(item ? item.kinopoiskId : null);
        }, function () { done(null); }, false, params);
      }

      if (imdb) {
        this.network.silent(base + 'imdbId=' + imdb, function (json) {
          var item = json && json.items && json.items[0];
          if (item && item.kinopoiskId) done(item.kinopoiskId);
          else byTitle();
        }, byTitle, false, params);
      } else {
        byTitle();
      }
    },

    askToken: function (done) {
      Lampa.Input.edit({
        title: 'Токен kinopoiskapiunofficial.tech',
        value: '',
        free: true,
        nosave: true
      }, function (value) {
        value = (value || '').trim();
        if (value) Lampa.Storage.set('oc_kp_token', value);
        done(value);
      });
    },

    askId: function (done) {
      Lampa.Input.edit({
        title: 'ID фильма на Кинопоиске (цифры из ссылки)',
        value: '',
        free: true,
        nosave: true
      }, function (value) {
        value = (value || '').replace(/\D/g, '');
        done(value || null);
      });
    },

    resolve: function (movie, done) {
      var id = this.fromCard(movie) || this.fromCache(movie);
      if (id) return done(id);

      var self = this;

      function search() {
        Lampa.Noty.show('Ищем фильм на Кинопоиске...');
        self.fromApi(movie, function (found) {
          if (found) {
            self.toCache(movie, found);
            return done(found);
          }
          self.askId(function (manual) {
            if (manual) self.toCache(movie, manual);
            done(manual);
          });
        });
      }

      if (!Settings.token()) self.askToken(search);
      else search();
    }
  };

  // ========== ОТКРЫТИЕ СТРАНИЦЫ ==========
  var Viewer = {
    buildUrl: function (kpId, movie) {
      var isSerial = !!(movie.number_of_seasons || (movie.first_air_date && !movie.release_date));
      return 'https://' + Settings.domain() + '/' + (isSerial ? 'series' : 'film') + '/' + kpId + '/';
    },

    openExternal: function (url) {
      if (Lampa.Utils && Lampa.Utils.openLink) Lampa.Utils.openLink(url);
      else window.open(url, '_blank');
    },

    openFrame: function (url) {
      var prev = Lampa.Controller.enabled().name;

      var box = $(
        '<div style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:#000;display:flex;flex-direction:column">' +
          '<div class="oc-bar" style="display:flex;gap:1em;padding:.6em 1em;background:#111">' +
            '<div class="selector oc-close" style="padding:.5em 1.2em;border-radius:6px;background:#333;color:#fff">← Назад</div>' +
            '<div class="selector oc-ext" style="padding:.5em 1.2em;border-radius:6px;background:#333;color:#fff">Открыть в браузере</div>' +
          '</div>' +
          '<iframe src="' + url + '" style="flex:1;border:0;width:100%" allowfullscreen ' +
            'allow="autoplay; fullscreen; encrypted-media"></iframe>' +
        '</div>'
      );

      function close() {
        box.remove();
        Lampa.Controller.toggle(prev);
      }

      box.find('.oc-close').on('hover:enter click', close);
      box.find('.oc-ext').on('hover:enter click', function () {
        Viewer.openExternal(url);
      });

      $('body').append(box);

      Lampa.Controller.add('online_cinema_frame', {
        toggle: function () {
          Lampa.Controller.collectionSet(box.find('.oc-bar'));
          Lampa.Controller.collectionFocus(box.find('.oc-close')[0], box.find('.oc-bar'));
        },
        left: function () { Navigator.move('left'); },
        right: function () { Navigator.move('right'); },
        back: close
      });
      Lampa.Controller.toggle('online_cinema_frame');
    },

    open: function (movie) {
      KP.resolve(movie, function (kpId) {
        if (!kpId) return Lampa.Noty.show('Не удалось определить ID на Кинопоиске');

        var url = Viewer.buildUrl(kpId, movie);
        console.log(TAG, 'Открываем', url);

        Lampa.Select.show({
          title: 'Как открыть?',
          items: [
            { title: 'Внутри Lampa', mode: 'frame' },
            { title: 'Во внешнем браузере', mode: 'external' }
          ],
          onSelect: function (item) {
            if (item.mode === 'frame') Viewer.openFrame(url);
            else Viewer.openExternal(url);
          },
          onBack: function () {
            Lampa.Controller.toggle('full_start');
          }
        });
      });
    }
  };

  // ========== КНОПКА В КАРТОЧКЕ ==========
  var MOD_SELECTOR = '.view--online_mod, .view--online';

  Lampa.Listener.follow('full', function (e) {
    if (e.type !== 'complite') return;

    var movie = e.data.movie;
    var render = e.object.activity.render();

    if (render.find('.view--online-cinema').length) return;

    var btn = $(
      '<div class="full-start__button selector view--online-cinema">' +
        '<span>Смотреть онлайн</span>' +
      '</div>'
    );

    btn.on('hover:enter', function () {
      var modBtn = render.find(MOD_SELECTOR).not('.view--online-cinema').first();

      var items = [{ title: 'Kinopoisk.cx (мой плеер)', mode: 'kpcx' }];
      if (modBtn.length) items.push({ title: 'Online Mod', mode: 'mod' });

      Lampa.Select.show({
        title: 'Смотреть онлайн',
        items: items,
        onSelect: function (item) {
          if (item.mode === 'kpcx') {
            Viewer.open(movie);
          } else {
            Lampa.Controller.toggle('full_start');
            modBtn.trigger('hover:enter');
          }
        },
        onBack: function () {
          Lampa.Controller.toggle('full_start');
        }
      });
    });

    // Прячем оригинальную кнопку online_mod, чтобы осталась одна точка входа.
    // Не нужно — удалите эту строку.
    render.find(MOD_SELECTOR).not('.view--online-cinema').hide();

    var torrent = render.find('.view--torrent');
    if (torrent.length) torrent.before(btn);
    else render.find('.full-start-new__buttons, .full-start__buttons').first().prepend(btn);
  });

  console.log(TAG, 'v3.0.0 загружен');
})();
