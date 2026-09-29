/**
 * Lampa Plugin — Смотреть онлайн через kinopoisk.cx
 * Версия: 4.0.0
 *
 * В карточке фильма кнопка "Смотреть онлайн" открывает список:
 *   1. Kinopoisk.cx — прямой поток (Alloha)  -> озвучка -> плеер Lampa / внешний плеер
 *   2. Kinopoisk.cx — страница на сайте       -> iframe или браузер
 *   3. Online Mod                             -> если найден на карточке
 *
 * Прямой поток работает по цепочке, которую делает сам сайт:
 *   p.linkpp.ink/api/players?kinopoisk=ID  ->  iframe Alloha  ->  POST /bnsi/movies/{id}  ->  m3u8
 *
 * Токен Кинопоиска не хранится в коде: плагин спросит его и запомнит в Lampa.Storage.
 * Любая ошибка показывается на экране текстом.
 */
(function () {
  'use strict';

  if (typeof Lampa === 'undefined') return;
  if (window.online_cinema_kp_loaded) return;
  window.online_cinema_kp_loaded = true;

  var TAG = '[OnlineCinema]';
  var PLAYERS_API = 'https://p.linkpp.ink/api/players?kinopoisk=';

  function toast(msg) {
    try { Lampa.Noty.show(msg); } catch (e) { console.log(TAG, msg); }
  }

  function fail(where, err) {
    var text = (err && err.message) ? err.message : String(err);
    console.log(TAG, where, err);
    toast('Ошибка [' + where + ']: ' + text);
  }

  // ========== НАСТРОЙКИ ==========
  var Settings = {
    domain: function () { return Lampa.Storage.get('oc_domain', 'kinopoisk.cx'); },
    token: function () { return Lampa.Storage.get('oc_kp_token', ''); }
  };

  // ========== HTTP (через Lampa.Reguest, у каждого запроса свой экземпляр) ==========
  var Http = {
    get: function (url, dataType, ok, err) {
      var net = new Lampa.Reguest();
      net.silent(url, ok, function (e) { err(e); }, false, { dataType: dataType });
    },
    post: function (url, body, ok, err) {
      var net = new Lampa.Reguest();
      net.silent(url, ok, function (e) { err(e); }, body, {
        dataType: 'json',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
    }
  };

  // ========== ПОИСК KINOPOISK ID ==========
  var KP = {
    net: function () { return new Lampa.Reguest(); },

    fromCard: function (movie) {
      return movie.kinopoisk_id || movie.kp_id ||
        (movie.external_ids && (movie.external_ids.kinopoisk_id || movie.external_ids.kp_id)) || null;
    },

    cacheKey: function (movie) {
      return movie.imdb_id || (movie.external_ids && movie.external_ids.imdb_id) || 'tmdb' + movie.id;
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
        self.net().silent(url, function (json) {
          var item = json && json.items && json.items[0];
          done(item ? item.kinopoiskId : null);
        }, function () { done(null); }, false, params);
      }

      if (imdb) {
        this.net().silent(base + 'imdbId=' + imdb, function (json) {
          var item = json && json.items && json.items[0];
          if (item && item.kinopoiskId) done(item.kinopoiskId);
          else byTitle();
        }, byTitle, false, params);
      } else {
        byTitle();
      }
    },

    safeInput: function (title, cb) {
      setTimeout(function () {
        try {
          if (Lampa.Input && Lampa.Input.edit) {
            Lampa.Input.edit({ title: title, value: '', free: true, nosave: true }, function (v) {
              cb(v || '');
            });
          } else {
            toast('В этой версии Lampa нет окна ввода (Lampa.Input)');
          }
        } catch (err) {
          fail('ввод', err);
        }
      }, 300);
    },

    askToken: function (done) {
      this.safeInput('Токен kinopoiskapiunofficial.tech', function (value) {
        value = (value || '').trim();
        if (value) Lampa.Storage.set('oc_kp_token', value);
        done(value);
      });
    },

    askId: function (done) {
      this.safeInput('ID фильма на Кинопоиске (цифры из ссылки)', function (value) {
        value = (value || '').replace(/\D/g, '');
        done(value || null);
      });
    },

    resolve: function (movie, done) {
      var id = this.fromCard(movie) || this.fromCache(movie);
      if (id) return done(id);

      var self = this;

      function search() {
        toast('Ищем фильм на Кинопоиске...');
        try {
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
        } catch (err) {
          fail('поиск ID', err);
        }
      }

      if (!Settings.token()) self.askToken(search);
      else search();
    }
  };

  // ========== ПРЯМОЙ ПОТОК (Alloha) ==========
  var Direct = {
    // Разбор HTML страницы плеера: токен + fileList
    parseIframe: function (html) {
      var tokenMatch = html.match(/token:\s*'([^']+)'/);
      var listMatch = html.match(/const fileList = JSON\.parse\('([\s\S]*?)'\);/);
      if (!tokenMatch) throw new Error('в странице плеера нет токена');
      if (!listMatch) throw new Error('в странице плеера нет списка файлов');

      var raw = listMatch[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      return { token: tokenMatch[1], list: JSON.parse(raw) };
    },

    // Рекурсивный поиск файла озвучки: ключ вида t{id}
    findFile: function (all, tid) {
      if (!all || typeof all !== 'object') return null;
      var key = 't' + tid;
      if (all[key] && all[key].id) return all[key].id;
      for (var k in all) {
        if (all.hasOwnProperty(k)) {
          var r = this.findFile(all[k], tid);
          if (r) return r;
        }
      }
      return null;
    },

    start: function (kpId, movie) {
      var self = this;
      toast('Загружаем список плееров...');

      Http.get(PLAYERS_API + kpId, 'json', function (res) {
        try {
          var players = (res && res.data) || [];
          var alloha = null;
          for (var i = 0; i < players.length; i++) {
            if (players[i].type === 'Alloha') alloha = players[i];
          }
          if (!alloha || !alloha.iframeUrl) {
            toast('Alloha для этого фильма не найден. Откройте страницу на сайте.');
            return;
          }
          self.loadIframe(alloha, movie);
        } catch (err) {
          fail('список плееров', err);
        }
      }, function () {
        toast('Не удалось получить список плееров (возможно, блокировка запроса)');
      });
    },

    loadIframe: function (alloha, movie) {
      var self = this;
      Http.get(alloha.iframeUrl, 'text', function (html) {
        try {
          var parsed = self.parseIframe(String(html));
          self.chooseFile(parsed, alloha, movie);
        } catch (err) {
          fail('страница плеера', err);
        }
      }, function () {
        toast('Не удалось загрузить страницу плеера (возможно, блокировка запроса)');
      });
    },

    // Названия озвучек по id из ответа players
    names: function (alloha) {
      var map = {};
      (alloha.translations || []).forEach(function (t) { map[t.id] = t.name; });
      return map;
    },

    chooseFile: function (parsed, alloha, movie) {
      var self = this;
      var fl = parsed.list;
      var names = this.names(alloha);

      if (fl.type === 'serial' && fl.all) {
        var seasons = Object.keys(fl.all).sort(function (a, b) { return a - b; });
        this.select('Сезон', seasons.map(function (s) { return { title: 'Сезон ' + s, v: s }; }), function (s) {
          var eps = Object.keys(fl.all[s.v]).sort(function (a, b) { return a - b; });
          self.select('Серия', eps.map(function (e) { return { title: 'Серия ' + e, v: e }; }), function (e) {
            var files = fl.all[s.v][e.v];
            var items = Object.keys(files).map(function (k) {
              var tid = k.replace('t', '');
              return { title: names[tid] || ('Озвучка ' + tid), fid: files[k].id };
            });
            self.select('Озвучка', items, function (t) {
              self.fetchStream(parsed.token, t.fid, alloha, movie,
                (movie.title || movie.name || '') + ' — С' + s.v + ' Э' + e.v);
            });
          });
        });
        return;
      }

      // Фильм: озвучки берём из ответа players
      var trs = alloha.translations || [];
      if (!trs.length) {
        var fid0 = fl.active && fl.active.id;
        if (!fid0) return toast('Не найден файл фильма');
        return this.fetchStream(parsed.token, fid0, alloha, movie, movie.title || movie.name || '');
      }

      var items = trs.map(function (t) { return { title: t.name, tr: t }; });
      this.select('Озвучка', items, function (item) {
        var fid = self.findFile(fl.all, item.tr.id);
        if (fid) return self.fetchStream(parsed.token, fid, alloha, movie, movie.title || movie.name || '');

        // если в списке нет — берём страницу этой озвучки
        Http.get(item.tr.iframeUrl, 'text', function (html) {
          try {
            var p2 = self.parseIframe(String(html));
            var id2 = p2.list.active && p2.list.active.id;
            if (!id2) throw new Error('не найден файл озвучки');
            self.fetchStream(p2.token, id2, alloha, movie, movie.title || movie.name || '');
          } catch (err) {
            fail('озвучка', err);
          }
        }, function () { toast('Не удалось загрузить озвучку'); });
      });
    },

    fetchStream: function (token, fileId, alloha, movie, title) {
      var self = this;
      var origin = alloha.iframeUrl.match(/^https?:\/\/[^\/]+/)[0];
      var body = 'token=' + encodeURIComponent(token) + '&av1=false&autoplay=0&audio=&subtitle=';

      toast('Получаем ссылку на видео...');

      Http.post(origin + '/bnsi/movies/' + fileId, body, function (json) {
        try {
          var sources = json && json.hlsSource;
          if (!sources || !sources.length) throw new Error('сервер не вернул видео');

          if (sources.length > 1) {
            var items = sources.map(function (s, i) { return { title: s.label || ('Дорожка ' + (i + 1)), src: s }; });
            self.select('Озвучка в файле', items, function (it) { self.play(it.src, json.tracks, title); });
          } else {
            self.play(sources[0], json.tracks, title);
          }
        } catch (err) {
          fail('получение видео', err);
        }
      }, function () {
        toast('Сервер плеера не отдал ссылку (возможно, блокировка запроса из Lampa)');
      });
    },

    play: function (source, tracks, title) {
      var q = source.quality || {};
      var keys = Object.keys(q).sort(function (a, b) { return b - a; });
      if (!keys.length) return toast('Нет доступных качеств');

      // по умолчанию 1080, иначе самое высокое из доступных не выше 1080
      var best = keys[0];
      for (var i = 0; i < keys.length; i++) {
        if (parseInt(keys[i], 10) <= 1080) { best = keys[i]; break; }
      }

      var quality = {};
      keys.forEach(function (k) { quality[k + 'p'] = q[k]; });

      var subs = [];
      (tracks || []).forEach(function (t) {
        if (t && t.src) subs.push({ label: t.label || 'Субтитры', url: t.src });
      });

      var data = { url: q[best], title: title, quality: quality };
      if (subs.length) data.subtitles = subs;

      try {
        Lampa.Player.play(data);
        if (Lampa.Player.playlist) Lampa.Player.playlist([data]);
      } catch (err) {
        fail('запуск плеера', err);
      }
    },

    select: function (title, items, cb) {
      Lampa.Select.show({
        title: title,
        items: items,
        onSelect: function (item) {
          try { cb(item); } catch (err) { fail(title, err); }
        },
        onBack: function () { Lampa.Controller.toggle('full_start'); }
      });
    }
  };

  // ========== ОТКРЫТИЕ СТРАНИЦЫ САЙТА ==========
  var Viewer = {
    buildUrl: function (kpId, movie) {
      var isSerial = !!(movie.number_of_seasons || (movie.first_air_date && !movie.release_date));
      return 'https://' + Settings.domain() + '/' + (isSerial ? 'series' : 'film') + '/' + kpId + '/';
    },

    openExternal: function (url) {
      try {
        if (Lampa.Utils && Lampa.Utils.openLink) Lampa.Utils.openLink(url);
        else window.open(url, '_blank');
      } catch (err) {
        fail('внешний браузер', err);
      }
    },

    openFrame: function (url) {
      try {
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

        var close = function () {
          box.remove();
          Lampa.Controller.toggle(prev);
        };

        box.find('.oc-close').on('hover:enter click', close);
        box.find('.oc-ext').on('hover:enter click', function () { Viewer.openExternal(url); });

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
      } catch (err) {
        fail('окно плеера', err);
      }
    },

    open: function (movie) {
      KP.resolve(movie, function (kpId) {
        try {
          if (!kpId) return toast('Не удалось определить ID на Кинопоиске');

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
            onBack: function () { Lampa.Controller.toggle('full_start'); }
          });
        } catch (err) {
          fail('выбор способа', err);
        }
      });
    },

    direct: function (movie) {
      KP.resolve(movie, function (kpId) {
        try {
          if (!kpId) return toast('Не удалось определить ID на Кинопоиске');
          Direct.start(kpId, movie);
        } catch (err) {
          fail('прямой поток', err);
        }
      });
    }
  };

  // ========== ПОИСК КНОПКИ ONLINE MOD ПО ТЕКСТУ ==========
  function findModButton(render) {
    var found = null;
    render.find('.full-start__button, .full-start-new__button, .selector').each(function () {
      var el = $(this);
      if (found) return;
      if (el.hasClass('view--online-cinema')) return;
      if (el.closest('.view--online-cinema').length) return;

      var text = (el.text() || '').toLowerCase();
      var cls = (el.attr('class') || '').toLowerCase();

      if (/shorts|shots|шорт|torrent|торрент|trailer|трейлер/.test(text + ' ' + cls)) return;
      if (/online|онлайн|онлаин/.test(text + ' ' + cls)) found = el;
    });
    return found;
  }

  // ========== КНОПКА В КАРТОЧКЕ ==========
  Lampa.Listener.follow('full', function (e) {
    if (e.type !== 'complite') return;

    try {
      var movie = e.data.movie;
      var render = e.object.activity.render();

      if (render.find('.view--online-cinema').length) return;

      var btn = $(
        '<div class="full-start__button selector view--online-cinema">' +
          '<span>Смотреть онлайн</span>' +
        '</div>'
      );

      var modBtn = findModButton(render);

      btn.on('hover:enter', function () {
        try {
          var items = [
            { title: 'Kinopoisk.cx — прямой поток (Alloha)', mode: 'direct' },
            { title: 'Kinopoisk.cx — страница на сайте', mode: 'page' }
          ];
          if (modBtn && modBtn.length) items.push({ title: 'Online Mod', mode: 'mod' });

          Lampa.Select.show({
            title: 'Смотреть онлайн',
            items: items,
            onSelect: function (item) {
              try {
                if (item.mode === 'direct') Viewer.direct(movie);
                else if (item.mode === 'page') Viewer.open(movie);
                else {
                  Lampa.Controller.toggle('full_start');
                  modBtn.trigger('hover:enter');
                }
              } catch (err) {
                fail('запуск', err);
              }
            },
            onBack: function () { Lampa.Controller.toggle('full_start'); }
          });
        } catch (err) {
          fail('список', err);
        }
      });

      // Прячем оригинальную кнопку online_mod, чтобы осталась одна точка входа.
      // Не нужно — удалите эту строку.
      if (modBtn && modBtn.length) modBtn.hide();

      var torrent = render.find('.view--torrent');
      if (torrent.length) torrent.before(btn);
      else render.find('.full-start-new__buttons, .full-start__buttons').first().prepend(btn);
    } catch (err) {
      fail('кнопка', err);
    }
  });

  console.log(TAG, 'v4.0.0 загружен');
})();
