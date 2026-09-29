--- public/plugin.js (原始)


+++ public/plugin.js (修改后)
/**
 * Lampa Plugin — Онлайн просмотр с редиректом через балансеры
 * Версия: 1.0.0
 *
 * Что делает плагин:
 * 1. Перехватывает открытие карточки фильма в Lampa
 * 2. Добавляет кнопку "Смотреть онлайн"
 * 3. При нажатии — берёт kinopoisk_id фильма
 * 4. Идёт в балансер (Alloha/Collaps/HDRezka) за видео
 * 5. Показывает выбор плеера и озвучки
 * 6. Запускает видео в плеере Lampa
 *
 * КАК УСТАНОВИТЬ:
 * 1. Загрузи этот файл на GitHub (в публичный репозиторий)
 * 2. Включи GitHub Pages (Settings → Pages → main branch)
 * 3. Скопируй ссылку: https://ТВОЙ_ЛОГИН.github.io/ИМЯ_РЕПО/plugin.js
 * 4. В Lampa: Настройки → Плагины → Добавить URL → вставь ссылку
 * 5. Перезапусти Lampa
 */
(function () {
  'use strict';

  // Проверяем, что Lampa доступна
  if (typeof Lampa === 'undefined') {
    console.log('[OnlineCinema] Lampa не найдена, плагин не загружен');
    return;
  }

  // ========== КОНФИГУРАЦИЯ ==========
  const Config = {
    name: 'OnlineCinema',
    version: '1.0.0',

    // Домен редиректа (можно менять в настройках)
    redirect_domain: 'kinopoisk.cx',

    // Список поддерживаемых балансеров
    players: {
      alloha: {
        name: 'Alloha',
        // Шаблон URL. {id} заменится на kinopoisk_id фильма
        url_template: 'https://alloha.tv/?kp={id}',
        color: '#22c55e',
        // Может ли отдавать HLS напрямую
        supports_hls: true
      },
      collaps: {
        name: 'Collaps',
        url_template: 'https://api.collaps.video/?kp={id}',
        color: '#3b82f6',
        supports_hls: true
      },
      hdrezka: {
        name: 'HDRezka',
        url_template: 'https://hdrezka.ag/engine/clear_new_ajax.php',
        color: '#f97316',
        supports_hls: false
      },
      kodik: {
        name: 'Kodik',
        url_template: 'https://kodik.info/find-player?kinopoisk_id={id}',
        color: '#a855f7',
        supports_hls: true
      }
    }
  };

  // ========== УТИЛИТЫ ==========
  const Utils = {
    // Создаём экземпляр Reguest для HTTP-запросов
    network: new Lampa.Reguest(),

    /**
     * Загрузить HTML страницу по URL
     */
    fetchPage: function (url, callback) {
      this.network.native(url, {}, function (html) {
        callback(null, html);
      }, function (error) {
        callback(error, null);
      });
    },

    /**
     * Показать уведомление пользователю
     */
    notify: function (message, duration) {
      if (Lampa.Noty) {
        Lampa.Noty.show(message, { time: duration || 3000 });
      } else {
        console.log('[OnlineCinema]', message);
      }
    },

    /**
     * Извлечь kinopoisk_id из данных фильма
     */
    getKinopoiskId: function (movieData) {
      // Пробуем разные варианты — в разных версиях Lampa поле может называться по-разному
      return movieData.kinopoisk_id ||
             (movieData.external_ids && movieData.external_ids.kinopoisk_id) ||
             (movieData.source && movieData.source.kinopoisk_id) ||
             null;
    },

    /**
     * Определить тип контента (фильм или сериал)
     */
    detectType: function (movieData) {
      if (movieData.number_of_seasons || movieData.type === 'tv') return 'serial';
      return 'film';
    }
  };

  // ========== РАБОТА С БАЛАНСЕРАМИ ==========
  const Balancer = {
    /**
     * Сформировать URL плеера для конкретного балансера
     */
    getPlayerUrl: function (playerKey, kinopoiskId) {
      const player = Config.players[playerKey];
      if (!player) return null;
      return player.url_template.replace('{id}', kinopoiskId);
    },

    /**
     * Загрузить страницу плеера и извлечь HLS ссылку
     */
    extractHLS: function (playerUrl, callback) {
      Utils.fetchPage(playerUrl, function (err, html) {
        if (err) return callback(err);

        // Паттерны для поиска HLS ссылки в HTML
        const patterns = [
          // JSON формат: "file":"https://...m3u8"
          /["']file["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
          // JSON формат: "src":"https://...m3u8"
          /["']src["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
          // JSON формат: "playlist_url":"https://...m3u8"
          /["']playlist_url["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i,
          // Прямая ссылка в кавычках
          /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
          // В src iframe или video
          /src=["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i
        ];

        for (let i = 0; i < patterns.length; i++) {
          const match = html.match(patterns[i]);
          if (match && match[1]) {
            // Убираем экранированные символы
            const url = match[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
            return callback(null, url);
          }
        }

        callback('HLS ссылка не найдена на странице плеера');
      });
    },

    /**
     * Получить список озвучек со страницы плеера
     */
    extractVoices: function (playerUrl, callback) {
      Utils.fetchPage(playerUrl, function (err, html) {
        if (err) return callback(err);

        const voices = [];

        // Паттерны для поиска озвучек (разные балансеры — разные форматы)
        const patterns = [
          // data-voice="id" > Название
          /data-voice=["']([^"']+)["'][^>]*>([^<]+)/gi,
          // "voice_name":"Название"
          /["']voice_name["']\s*:\s*["']([^"']+)["']/gi,
          // "title":"Название" (в контексте translations)
          /["']translation["']\s*:\s*\{[^}]*["']title["']\s*:\s*["']([^"']+)["']/gi
        ];

        for (let p = 0; p < patterns.length; p++) {
          let match;
          const regex = new RegExp(patterns[p].source, patterns[p].flags);
          while ((match = regex.exec(html)) !== null) {
            voices.push({
              id: match[1],
              title: match[2] ? match[2].trim() : match[1]
            });
          }
          if (voices.length > 0) break;
        }

        callback(null, voices);
      });
    }
  };

  // ========== ОСНОВНОЙ КОНТРОЛЛЕР ==========
  const Controller = {
    /**
     * Главный метод — начать просмотр фильма
     */
    startWatching: function (kinopoiskId, movieData) {
      Utils.notify('🔍 Ищем видео...');

      // Пробуем каждый балансер по очереди
      const playerKeys = Object.keys(Config.players);
      this.tryPlayers(playerKeys, 0, kinopoiskId, movieData);
    },

    /**
     * Перебирать балансеров пока не найдём рабочий
     */
    tryPlayers: function (playerKeys, index, kinopoiskId, movieData) {
      if (index >= playerKeys.length) {
        Utils.notify('❌ Видео не найдено ни в одном источнике');
        return;
      }

      const playerKey = playerKeys[index];
      const player = Config.players[playerKey];
      const playerUrl = Balancer.getPlayerUrl(playerKey, kinopoiskId);

      if (!playerUrl) {
        return this.tryPlayers(playerKeys, index + 1, kinopoiskId, movieData);
      }

      // Пробуем получить HLS с этого балансера
      Balancer.extractHLS(playerUrl, (err, hlsUrl) => {
        if (hlsUrl) {
          // Нашли! Спрашиваем озвучку или сразу играем
          this.onHLFound(hlsUrl, playerUrl, player, movieData);
        } else {
          // Не нашли — пробуем следующий балансер
          console.log('[OnlineCinema] ' + player.name + ' не сработал, пробуем следующий...');
          this.tryPlayers(playerKeys, index + 1, kinopoiskId, movieData);
        }
      });
    },

    /**
     * HLS найден — показываем выбор озвучки или запускаем
     */
    onHLFound: function (hlsUrl, playerUrl, player, movieData) {
      // Пробуем получить список озвучек
      Balancer.extractVoices(playerUrl, (err, voices) => {
        if (voices && voices.length > 1) {
          // Есть несколько озвучек — показываем выбор
          this.showVoiceSelect(voices, playerUrl, player, movieData);
        } else {
          // Одна озвучка или нет — сразу играем
          this.playVideo(hlsUrl, movieData, player.name);
        }
      });
    },

    /**
     * Показать диалог выбора озвучки
     */
    showVoiceSelect: function (voices, playerUrl, player, movieData) {
      if (!Lampa.Select) {
        // Если Select недоступен — просто играем первую озвучку
        Balancer.extractHLS(playerUrl, (err, hlsUrl) => {
          if (hlsUrl) this.playVideo(hlsUrl, movieData, player.name);
        });
        return;
      }

      Lampa.Select.show({
        title: 'Выберите озвучку (' + player.name + ')',
        items: voices.map(function (v) {
          return {
            title: v.title,
            subtitle: player.name,
            voice_id: v.id,
            voice_url: playerUrl + '&voice=' + v.id
          };
        }),
        onSelect: (item) => {
          Utils.notify('Загрузка: ' + item.title);
          Balancer.extractHLS(item.voice_url, (err, hlsUrl) => {
            if (hlsUrl) {
              this.playVideo(hlsUrl, movieData, player.name + ' • ' + item.title);
            } else {
              Utils.notify('❌ Не удалось загрузить видео');
            }
          });
        }
      });
    },

    /**
     * Запустить видео в плеере Lampa
     */
    playVideo: function (hlsUrl, movieData, sourceName) {
      const title = movieData.title || movieData.name || 'Видео';

      Utils.notify('▶️ Запуск: ' + sourceName);

      Lampa.Player.play({
        url: hlsUrl,
        title: title,
        poster: movieData.poster || movieData.poster_path || '',
        subtitle: sourceName,
        quality: {
          'auto': 'Авто'
        }
      });
    },

    /**
     * Показать диалог выбора балансера (если хочешь, чтобы пользователь выбрал)
     */
    showPlayerSelect: function (kinopoiskId, movieData) {
      if (!Lampa.Select) {
        // Если Select недоступен — пробуем все балансера автоматически
        this.startWatching(kinopoiskId, movieData);
        return;
      }

      const items = Object.keys(Config.players).map(function (key) {
        const p = Config.players[key];
        return {
          title: p.name,
          player_key: key,
          color: p.color
        };
      });

      Lampa.Select.show({
        title: 'Выберите источник видео',
        items: items,
        onSelect: (item) => {
          const playerUrl = Balancer.getPlayerUrl(item.player_key, kinopoiskId);
          Utils.notify('🔍 Ищем в ' + item.title + '...');

          Balancer.extractHLS(playerUrl, (err, hlsUrl) => {
            if (hlsUrl) {
              this.onHLFound(hlsUrl, playerUrl, Config.players[item.player_key], movieData);
            } else {
              Utils.notify('❌ ' + item.title + ': видео не найдено');
            }
          });
        }
      });
    }
  };

  // ========== ИНТЕГРАЦИЯ С LAMPA ==========

  /**
   * Добавить кнопку "Смотреть онлайн" в карточку фильма
   */
  function addWatchButton(kinopoiskId, movieData) {
    // Ждём, пока карточка отрендерится
    setTimeout(function () {
      // Ищем контейнер кнопок в карточке фильма
      // Селекторы могут отличаться в разных версиях Lampa
      const buttonContainers = [
        '.full-start-new__buttons',
        '.movie-head__buttons',
        '.full-start__buttons',
        '[class*="buttons"]'
      ];

      let container = null;
      for (let i = 0; i < buttonContainers.length; i++) {
        container = document.querySelector(buttonContainers[i]);
        if (container) break;
      }

      if (!container) {
        console.log('[OnlineCinema] Контейнер кнопок не найден');
        return;
      }

      // Проверяем, не добавлена ли уже наша кнопка
      if (container.querySelector('.online-cinema-btn')) return;

      // Создаём кнопку
      const btn = document.createElement('div');
      btn.className = 'online-cinema-btn';
      btn.innerHTML = '<i class="fas fa-play"></i> Смотреть онлайн';
      btn.style.cssText = [
        'background: linear-gradient(135deg, #7c3aed, #ec4899)',
        'padding: 0.7em 1.4em',
        'border-radius: 8px',
        'cursor: pointer',
        'display: inline-flex',
        'align-items: center',
        'gap: 8px',
        'font-size: 14px',
        'color: white',
        'margin-left: 8px',
        'font-weight: 500',
        'transition: transform 0.2s'
      ].join(';');

      // Hover эффект
      btn.addEventListener('mouseenter', function () {
        btn.style.transform = 'scale(1.05)';
        btn.style.opacity = '0.9';
      });
      btn.addEventListener('mouseleave', function () {
        btn.style.transform = 'scale(1)';
        btn.style.opacity = '1';
      });

      // Клик — запуск просмотра
      btn.addEventListener('click', function () {
        Controller.showPlayerSelect(kinopoiskId, movieData);
      });

      container.appendChild(btn);
      console.log('[OnlineCinema] Кнопка "Смотреть онлайн" добавлена');
    }, 1000);
  }

  /**
   * Слушатель открытия карточки фильма
   */
  Lampa.Listener.follow('full', {
    onStart: function (data) {
      if (!data || !data.object || !data.object.data) return;

      const movieData = data.object.data;
      const kinopoiskId = Utils.getKinopoiskId(movieData);

      if (kinopoiskId) {
        console.log('[OnlineCinema] Фильм:', movieData.title, '| КП ID:', kinopoiskId);
        addWatchButton(kinopoiskId, movieData);
      } else {
        console.log('[OnlineCinema] kinopoisk_id не найден для:', movieData.title);
      }
    }
  });

  /**
   * Перехват кликов по ссылкам Кинопоиска (дополнительная функция)
   */
  document.addEventListener('click', function (e) {
    const link = e.target.closest('a');
    if (!link) return;

    const href = link.getAttribute('href') || '';

    // Проверяем, это ли ссылка на Кинопоиск с ID фильма
    const kpMatch = href.match(/kinopoisk\.(?:ru|cx)\/(?:film|series)\/(\d+)/);
    if (kpMatch) {
      e.preventDefault();
      const kinopoiskId = kpMatch[1];
      const type = href.includes('/series/') ? 'serial' : 'film';

      Controller.showPlayerSelect(kinopoiskId, {
        title: link.textContent.trim() || 'Фильм',
        poster: '',
        type: type
      });
    }
  }, true);

  // ========== НАЧАЛЬНАЯ ИНИЦИАЛИЗАЦИЯ ==========
  function init() {
    console.log('%c[OnlineCinema] v' + Config.version + ' загружен ✓',
      'color: #a855f7; font-weight: bold; font-size: 14px');
    console.log('[OnlineCinema] Балансеры:', Object.keys(Config.players).join(', '));
  }

  // Запускаем инициализацию когда Lampa готова
  if (window.appready) {
    init();
  } else {
    Lampa.Listener.follow('app', {
      onReady: function () {
        init();
      }
    });
  }
})();
