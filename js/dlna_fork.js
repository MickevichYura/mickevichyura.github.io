(function () {
	'use strict';


	// Разбор S01E02 / 2x05 / _001 из имени файла
	function parseEpisode(name) {
		var m;
		if ((m = name.match(/[sS](\d{1,2})[\s._-]*[eE](\d{1,3})(?!\d)/)))                       return { season: +m[1], episode: +m[2] };
		if ((m = name.match(/(?:^|[^\dxX])(\d{1,2})x(\d{1,3})(?!\d)/)))                         return { season: +m[1], episode: +m[2] };
		if ((m = name.match(/(?:^|[\s._-])(?:ep?|episode|серия|s)[\s._-]?(\d{1,3})(?!\d)/i)))   return { season: 1, episode: +m[1] };
		if ((m = name.match(/[\s._-](\d{1,3})$/)))                                              return { season: 1, episode: +m[1] };
		return null;
	}

	var VOICE = 'DLNA'; // у локальных файлов нет озвучек, но Лампа ждёт непустое значение

	var RELEVANCE_THRESHOLD = 0.6; // 0 = точное вхождение, 1 = ничего общего
	var MAX_DEPTH   = 2;   // на сколько уровней вложенности спускаться
	var MAX_FOLDERS = 40;  // предохранитель от обхода всей библиотеки

	var BROWSER_ROOT  = 'Video'; // с какой папки сервера начинается страница DLNA
	var TREE_DEPTH    = 4;       // глубина сбора дерева для главной страницы
	var TREE_MAX_NODE = 100;     // сколько папок максимум обходим за один уровень

	var THUMB_PARALLEL = 4;    // сколько превью тянем одновременно, чтобы не завалить сервер
	var TMDB_MAX_LOOKUP = 40;  // сколько поисков TMDB максимум на один список

	var ICON_PLAY = "<svg viewBox=\"0 0 128 128\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"64\" cy=\"64\" r=\"56\" stroke=\"white\" stroke-width=\"16\"/><path d=\"M90.5 64.3827L50 87.7654L50 41L90.5 64.3827Z\" fill=\"white\"/></svg>";
	var ICON_FOLDER = "<svg viewBox=\"0 0 128 112\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><rect y=\"20\" width=\"128\" height=\"92\" rx=\"13\" fill=\"white\"/><path d=\"M29.9963 8H98.0037C96.0446 3.3021 91.4079 0 86 0H42C36.5921 0 31.9555 3.3021 29.9963 8Z\" fill=\"white\" fill-opacity=\"0.23\"/><rect x=\"11\" y=\"8\" width=\"106\" height=\"76\" rx=\"13\" fill=\"white\" fill-opacity=\"0.51\"/></svg>";

	var CONTROL_PATHS = [
		'ctl/ContentDir',                        // MiniDLNA (Keenetic, OpenWrt, ReadyMedia)
		'ContentDirectory/control',              // Synology DSM
		'upnp/control/ContentDirectory1',        // Serviio, Universal Media Server
		'MediaServer/ContentDirectory/Control',  // Twonky
		'dev0/srv0/control'                      // Plex DLNA
	];

	/**
	 * Работа с DLNA-сервером: общая для поиска по карточке и для браузера по серверу
	 */
	var DLNA = {

		// local proxy is needed for Synology NAS with old upnp sdk used (CORS restricted)
		// UPnP/1.0, Portable SDK for UPnP devices/1.6.18: https://github.com/pupnp/pupnp/commit/542c318acff73bf9be85b886a6e447bc473f57f2
		getProxyURL: function (url) {
			var proxy = Lampa.Storage.get('synology_nas_proxy') || Lampa.Storage.get('synology_dlna_proxy');
			if (proxy) {
				if (proxy.indexOf('http') === -1) proxy = 'http://' + proxy;
				url = proxy + (proxy.endsWith('/') ? '' : '/') + url;
			}
			return url;
		},

		soapBrowse: function (serviceURL, folder_id) {
			var soapAction = '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"';
			var soapBody = `
			<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
			<s:Body>
			<u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
			<ObjectID>`+folder_id+`</ObjectID>
			<BrowseFlag>BrowseDirectChildren</BrowseFlag>
			<Filter>*</Filter>
			<StartingIndex>0</StartingIndex>
			<RequestedCount>1000</RequestedCount>
			<SortCriteria></SortCriteria>
			</u:Browse>
			</s:Body>
			</s:Envelope>`;
			return new Promise(function (resolve) {
				$.ajax({
					url: serviceURL,
					type: "POST",
					dataType: "xml",
					data: soapBody,
					headers: {
						"SOAPAction": soapAction,
						"Content-Type": "text/xml"
					},
					success: function (response) {
						resolve(response && response.documentElement ? response.documentElement.outerHTML : null);
					},
					error: function () {
						resolve(null);
					}
				});
			});
		},

		parseXml: function (xmlResponse) {
			var parser = new DOMParser();
			var xmlDoc = parser.parseFromString(xmlResponse, "text/xml");
			var resultNode = xmlDoc.getElementsByTagName('Result')[0];
			if (!resultNode) return null;
			var result = resultNode.textContent;
			var decodedResult;
			try { decodedResult = decodeURIComponent(result); }
			catch (e) { decodedResult = result; } // имена файлов с '%' ломают decodeURIComponent
			var resultDoc = parser.parseFromString(decodedResult, "text/xml");
			var containers = resultDoc.getElementsByTagName('container');
			var items = resultDoc.getElementsByTagName('item');
			var filesAndDirectories = [];
			var parseNode = function (node) {
				var nodeInfo = { resources: [] };
				for (var i = 0; i < node.attributes.length; i++) {
					nodeInfo[node.attributes[i].name] = node.attributes[i].value;
				}
				for (var i = 0; i < node.childNodes.length; i++) {
					if (node.childNodes[i].nodeType === 1) { // if element node
						var child = node.childNodes[i];
						var name = child.nodeName;
						if (name === 'dc:title') name = 'title';
						if (name === 'upnp:class') name = 'type';

						// <res> у элемента несколько: сам файл и превью разных размеров
						if (name === 'res') {
							var res = { url: child.textContent };
							for (var r = 0; r < child.attributes.length; r++) {
								res[child.attributes[r].name] = child.attributes[r].value;
							}
							nodeInfo.resources.push(res);
							if (nodeInfo.url) continue; // основным остаётся первый, как и раньше
							name = 'url';
						}

						if (nodeInfo[name]) continue;
						nodeInfo[name] = child.textContent;
						for (var j = 0; j < child.attributes.length; j++) {
							nodeInfo[child.attributes[j].name] = child.attributes[j].value;
						}
					}
				}
				return nodeInfo;
			};
			for (var i = 0; i < containers.length; i++) {
				filesAndDirectories.push(parseNode(containers[i]));
			}
			for (var i = 0; i < items.length; i++) {
				filesAndDirectories.push(parseNode(items[i]));
			}
			return filesAndDirectories;
		},

		browse: async function (folder_id) {
			if (typeof folder_id === 'undefined') folder_id = 0;

			var serverDLNA = Lampa.Storage.get('synology_nas_server');
			if (!serverDLNA || serverDLNA === '') {
				Lampa.Noty.show('DLNA: не задан адрес сервера');
				console.error('DLNA', 'Не задан адрес сервера');
				return [];
			}

			var base = serverDLNA + (serverDLNA.endsWith('/') ? '' : '/');
			if (base.indexOf('http') === -1) base = 'http://' + base;

			// известный рабочий путь пробуем первым, иначе перебираем кандидатов
			var known = Lampa.Storage.get('dlna_control_path', '');
			var candidates = known ? [known].concat(CONTROL_PATHS.filter(function (p) { return p !== known; })) : CONTROL_PATHS.slice();

			for (var i = 0; i < candidates.length; i++) {
				var url = DLNA.getProxyURL(base + candidates[i]);
				var xml = await DLNA.soapBrowse(url, folder_id);
				if (xml) {
					var parsed = DLNA.parseXml(xml);
					if (parsed !== null) {
						if (known !== candidates[i]) {
							Lampa.Storage.set('dlna_control_path', candidates[i]);
							console.log('DLNA', 'control path:', candidates[i]);
						}
						return parsed;
					}
				}
			}

			Lampa.Noty.show('DLNA: не удалось подключиться к серверу');
			console.error('DLNA', 'ни один control-путь не ответил', base, CONTROL_PATHS);
			return [];
		},

		isFolder: function (node) {
			return (node.type || '').indexOf('object.container') === 0;
		},

		isVideo: function (node) {
			return (node.type || '').indexOf('object.item.videoItem') === 0;
		},

		isAudio: function (node) {
			return (node.type || '').indexOf('object.item.audioItem') === 0;
		},

		/**
		 * Сезон и серия: сервер отдаёт их в метаданных, это надёжнее разбора имени файла
		 */
		episode: function (node) {
			var s = parseInt(node['upnp:episodeSeason']);
			var e = parseInt(node['upnp:episodeNumber']);
			if (!isNaN(s) && !isNaN(e) && e > 0) return { season: s, episode: e };
			return parseEpisode(node.title || '');
		},

		/**
		 * Имя для поиска в TMDB: отрезаем маркер серии, год и релизные теги
		 */
		cleanName: function (name) {
			var s = (name || '').replace(/\.[a-z0-9]{2,4}$/i, ''); // расширение
			s = s.replace(/[._]+/g, ' ');
			s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');           // [qqss44], (S02)
			s = s.split(/\b(?:s\d{1,2}\s?e\d{1,3}|\d{1,2}x\d{1,3})\b/i)[0];
			s = s.replace(/\bs\d{1,2}\b.*$/i, ' ');                // одинокий S01 и всё после
			s = s.replace(/\b(19|20)\d{2}\b.*$/, ' ');             // год и всё после
			s = s.replace(/\b(2160p|1080p|720p|480p|4k|uhd|hdr|sdr|web-?dl|webrip|blu-?ray|bdrip|hdrip|dvdrip|remux|x26[45]|h\.?26[45]|hevc|avc|aac|ac3|dts|ddp?5?\.?1?|rus|eng|sub|subs|dub|avo|dvo|mvo)\b.*$/i, ' ');
			return s.replace(/\s+/g, ' ').trim();
		},

		/**
		 * Ссылка на превью, если сервер его отдаёт
		 *
		 * Два штатных места: upnp:albumArtURI и отдельный <res> с профилем
		 * JPEG_TN/JPEG_SM. MiniDLNA делает превью для видео только если собран
		 * с ffmpegthumbnailer и включён enable_thumbnail - иначе будет пусто.
		 */
		thumb: function (node) {
			var art = node['upnp:albumArtURI'] || node['upnp:icon'] || '';
			if (art) return DLNA.getProxyURL(art);

			var list = node.resources || [];
			var pick = list.filter(function (r) { return /JPEG_(TN|SM)/i.test(r.protocolInfo || ''); })[0];

			// у самих картинок превью может не быть - тогда годится любой image-ресурс
			if (!pick) pick = list.filter(function (r) { return /image\/(jpeg|png)/i.test(r.protocolInfo || ''); })[0];

			return pick && pick.url ? DLNA.getProxyURL(pick.url) : '';
		},

		/**
		 * Ключ файла для таймлайна и отметок просмотра
		 *
		 * Один и тот же файл получает разные ObjectID в разных разделах сервера
		 * (All Video, Recently Added, обычная папка), поэтому id брать нельзя -
		 * иначе прогресс просмотра у одного файла будет свой в каждом разделе.
		 * Путь ресурса от раздела не зависит.
		 */
		fileKey: function (node) {
			var path = (node.url || node.path || '').replace(/^[a-z]+:\/\/[^\/]+/i, '');
			return path || node.title || '';
		},

		fileHash: function (node) {
			return Lampa.Utils.hash(DLNA.fileKey(node));
		},

		/**
		 * Один файл живёт под разными ключами: страница DLNA считает хеш по пути
		 * ресурса, а карточка фильма - по сезону/серии/original_title (так прогресс
		 * общий с другими онлайн-балансерами). Оба ключа знает только карточка,
		 * поэтому она их связывает, а дальше прогресс переносится в обе стороны.
		 */
		linkHash: function (file_hash, timeline_hash, viewed_hash) {
			if (!file_hash || !timeline_hash) return;

			var links = Lampa.Storage.cache('dlna_hash_link', 1000, {});
			var cur = links[file_hash];
			if (cur && cur.t === timeline_hash && cur.v === viewed_hash) return;

			links[file_hash] = { t: timeline_hash, v: viewed_hash };
			Lampa.Storage.set('dlna_hash_link', links);
		},

		linkedHash: function (file_hash) {
			return file_hash ? (Lampa.Storage.cache('dlna_hash_link', 1000, {})[file_hash] || null) : null;
		},

		/**
		 * Перенести прогресс на тот ключ, где он старее
		 */
		syncTimeline: function (hash_a, hash_b) {
			if (!hash_a || !hash_b || hash_a === hash_b) return;

			var a = Lampa.Timeline.view(hash_a);
			var b = Lampa.Timeline.view(hash_b);
			var from = (a.updated || 0) >= (b.updated || 0) ? a : b;
			var to = from === a ? b : a;

			if (!from.updated) return;
			// одинаковые данные не переписываем, иначе каждый рендер дёргает хранилище
			if (to.time === from.time && to.percent === from.percent && to.duration === from.duration) return;

			to.percent = from.percent;
			to.time = from.time;
			to.duration = from.duration;
			Lampa.Timeline.update(to);
		},

		/**
		 * Отметка "просмотрено" (звёздочка) - общая для обоих ключей
		 */
		syncViewed: function (hash_a, hash_b) {
			if (!hash_a || !hash_b || hash_a === hash_b) return;

			var viewed = Lampa.Storage.cache('online_view', 5000, []);
			var has_a = viewed.indexOf(hash_a) !== -1;
			var has_b = viewed.indexOf(hash_b) !== -1;
			if (has_a === has_b) return;

			viewed.push(has_a ? hash_b : hash_a);
			Lampa.Storage.set('online_view', viewed);
		},

		/**
		 * ObjectID папки по её пути от корня, например 'Video' или 'Video/Folders'
		 * @returns {String|null} null - такой папки на сервере нет
		 */
		resolvePath: async function (path) {
			var id = '0';
			var parts = (path || '').replace(/^\/+|\/+$/g, '').split('/').filter(function (p) { return p; });

			for (var i = 0; i < parts.length; i++) {
				var nodes = await DLNA.browse(id);
				var want = parts[i].toLowerCase();
				var found = nodes.filter(DLNA.isFolder).filter(function (n) {
					return (n.title || '').toLowerCase() === want;
				})[0];

				if (!found) return null;
				id = found.id;
			}
			return id;
		},

		/**
		 * Собрать содержимое ветки: папки с видео и отдельные файлы, лежащие по пути
		 *
		 * Обход идёт по уровням (все запросы уровня - параллельно). Папка, у которой
		 * нет подпапок, становится карточкой; папка с подпапками "прозрачная" -
		 * её файлы поднимаются наверх, а подпапки обходятся дальше. Так виртуальные
		 * разделы DLNA (Video / Folders / ...) не мешают увидеть реальную библиотеку.
		 */
		collect: async function (start_id, depth) {
			var folders = [], files = [];
			var seen_folder = {}, seen_file = {};

			var addFolder = function (node, count) {
				var key = (node.title || '').toLowerCase();
				if (!key || seen_folder[key]) return;
				seen_folder[key] = true;
				if (!node.childCount && count) node.childCount = count;
				folders.push(node);
			};
			var addFile = function (node) {
				var key = DLNA.fileKey(node).toLowerCase();
				if (!key || seen_file[key]) return;
				seen_file[key] = true;
				files.push(node);
			};

			var queue = [{ id: start_id, node: null }]; // node null - стартовая папка, всегда прозрачная

			for (var d = 0; d < depth && queue.length; d++) {
				var lists = await Promise.all(queue.map(function (entry) { return DLNA.browse(entry.id); }));
				var next = [];

				queue.forEach(function (entry, i) {
					var nodes = lists[i] || [];
					var subs = nodes.filter(DLNA.isFolder);
					var vids = nodes.filter(DLNA.isVideo);

					if (entry.node && !subs.length) {
						if (vids.length) addFolder(entry.node, vids.length); // конечная папка с видео
						return;
					}

					vids.forEach(addFile);
					subs.forEach(function (sub) { next.push({ id: sub.id, node: sub }); });
				});

				// слишком широкое дерево - дальше не идём, показываем как есть
				if (next.length > TREE_MAX_NODE) {
					next.forEach(function (entry) { addFolder(entry.node); });
					next = [];
				}
				queue = next;
			}

			// упёрлись в ограничение глубины - остаток показываем папками
			queue.forEach(function (entry) { addFolder(entry.node); });

			return { folders: folders, files: files };
		},

		/**
		 * Когда файл/папку смотрели в последний раз
		 */
		viewTimes: function () {
			return Lampa.Storage.cache('dlna_view_time', 500, {});
		},

		markView: function () {
			var times = DLNA.viewTimes();
			var now = Date.now();
			for (var i = 0; i < arguments.length; i++) {
				if (arguments[i]) times[String(arguments[i]).toLowerCase()] = now;
			}
			Lampa.Storage.set('dlna_view_time', times);
		},

		viewTime: function (key) {
			return key ? (DLNA.viewTimes()[String(key).toLowerCase()] || 0) : 0;
		},

		viewDate: function (key) {
			var time = DLNA.viewTime(key);
			if (!time) return '';
			var d = new Date(time);
			return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
		},

		// '0:58:55.072' -> секунды
		durationSeconds: function (value) {
			var parts = String(value || '').split(':');
			if (parts.length < 2) return 0;

			var sec = 0;
			for (var i = 0; i < parts.length; i++) sec = sec * 60 + parseFloat(parts[i]);

			return isNaN(sec) ? 0 : sec;
		},

		humanSize: function (bytes) {
			var size = parseInt(bytes);
			if (!size || isNaN(size)) return '';
			var unit = ['B', 'KB', 'MB', 'GB', 'TB'];
			var i = 0;
			while (size >= 1024 && i < unit.length - 1) { size = size / 1024; i++; }
			return (i > 1 ? size.toFixed(2) : Math.round(size)) + ' ' + unit[i];
		}
	};

	/**
	 * TMDB: постеры для папок, кадры и названия серий для файлов
	 *
	 * Локальный сервер картинок не отдаёт, поэтому превью берём отсюда.
	 * Всё кешируется в Storage, промахи тоже - чтобы не искать по кругу
	 * домашнее видео, которого в базе нет.
	 */
	var TMDB = {
		net: null,

		request: function (url) {
			if (!TMDB.net) TMDB.net = new Lampa.Reguest();

			return new Promise(function (resolve) {
				TMDB.net.silent(Lampa.TMDB.api(url), resolve, function () { resolve(null); });
			});
		},

		lang: function () {
			return Lampa.Storage.get('language', 'ru');
		},

		params: function (lang) {
			return 'api_key=' + Lampa.TMDB.key() + '&language=' + (lang || TMDB.lang());
		},

		image: function (path, size) {
			return path ? Lampa.TMDB.image('t/p/' + size + path) : '';
		},

		/**
		 * Сопоставить имя папки или файла с фильмом/сериалом
		 */
		match: async function (title) {
			var key = DLNA.cleanName(title).toLowerCase();
			if (!key) return null;

			// ключ с цифрой: в старом кеше не было названия, а оно нужно для заголовка в плеере
			var cache = Lampa.Storage.cache('dlna_tmdb_match2', 500, {});
			if (cache[key]) return cache[key].miss ? null : cache[key];

			var json = await TMDB.request('search/multi?' + TMDB.params() + '&query=' + encodeURIComponent(key));
			var found = json && json.results ? json.results.filter(function (r) {
				return (r.media_type === 'tv' || r.media_type === 'movie') && r.poster_path;
			})[0] : null;

			cache = Lampa.Storage.cache('dlna_tmdb_match2', 500, {});
			cache[key] = found ? {
				type: found.media_type,
				id: found.id,
				poster: found.poster_path,
				name: found.name || found.title || ''
			} : { miss: 1 };
			Lampa.Storage.set('dlna_tmdb_match2', cache);

			return found ? cache[key] : null;
		},

		mapEpisodes: function (json) {
			var episodes = {};

			if (json && json.episodes) json.episodes.forEach(function (e) {
				episodes[e.episode_number] = {
					still: e.still_path || '',
					name: e.name || '',
					rating: e.vote_average || 0,
					date: e.air_date || '',
					runtime: e.runtime || 0,
					overview: e.overview || '' // только признак наличия перевода, в кеш не кладём
				};
			});

			return episodes;
		},

		// без перевода TMDB отдаёт заглушку вида "Эпизод 5" и пустое описание
		isPlaceholder: function (name) {
			return !name || /^(эпизод|серия|episode)\s*\d+$/i.test(name.trim());
		},

		needTranslation: function (episodes) {
			var list = Object.keys(episodes);
			if (!list.length) return false;

			var placeholders = list.filter(function (n) { return TMDB.isPlaceholder(episodes[n].name); }).length;
			var empty = list.filter(function (n) { return !episodes[n].overview; }).length;

			return placeholders > 0 || empty === list.length;
		},

		/**
		 * Кадры, названия, рейтинг, даты и длительности всех серий сезона - одним запросом
		 */
		season: async function (id, season) {
			var key = id + '_' + season;

			var cache = Lampa.Storage.cache('dlna_tmdb_episodes', 200, {});
			if (cache[key]) return cache[key];

			var lang = TMDB.lang();
			var episodes = TMDB.mapEpisodes(await TMDB.request('tv/' + id + '/season/' + season + '?' + TMDB.params(lang)));

			// нет перевода - добираем англоязычные названия, иначе в списке будут "Эпизод 1, 2, 3"
			if (lang.indexOf('en') !== 0 && TMDB.needTranslation(episodes)) {
				var fallback = TMDB.mapEpisodes(await TMDB.request('tv/' + id + '/season/' + season + '?' + TMDB.params('en-US')));

				Object.keys(episodes).forEach(function (num) {
					if (fallback[num] && TMDB.isPlaceholder(episodes[num].name)) episodes[num].name = fallback[num].name;
				});
			}

			Object.keys(episodes).forEach(function (num) { delete episodes[num].overview; }); // описания не показываем, место в хранилище не занимаем

			cache = Lampa.Storage.cache('dlna_tmdb_episodes', 200, {});
			cache[key] = episodes;
			Lampa.Storage.set('dlna_tmdb_episodes', cache);

			return episodes;
		}
	};

	function synology(component, _object) {
		var network = new Lampa.Reguest();
		var extract = {};
		var results = [];
		var object = _object;
		var episodes = {}; // серии по сезонам из TMDB для этой карточки
		var filter_items = {};
		var choice = {
			season: 0,
			voice: 0,
			voice_name: ''
		};


		this.getProxyURL = DLNA.getProxyURL;

		this.levenshtein = function (a, b) {
			const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));

			for (let i = 0; i <= a.length; i++) {
				matrix[i][0] = i;
			}

			for (let j = 0; j <= b.length; j++) {
				matrix[0][j] = j;
			}

			for (let i = 1; i <= a.length; i++) {
				for (let j = 1; j <= b.length; j++) {
					if (a[i - 1] === b[j - 1]) {
						matrix[i][j] = matrix[i - 1][j - 1];
					} else {
						matrix[i][j] = Math.min(
			          matrix[i - 1][j] + 1,      // Удаление
			          matrix[i][j - 1] + 1,      // Вставка
			          matrix[i - 1][j - 1] + 1   // Замена
			          );
					}
				}
			}

			return matrix[a.length][b.length];
		}


		this.cleanTitle = function (title) {
			return title
          .replace(/\b(SDR|WEBDL|4K|2160p|480p|720p|1080p|x264|Blu-Ray|Remux|UHD|HDRip|WEBRip|WEB-DL|AVC|BDRip|Rus|Eng|Dub|AVO|Sub)\b/gi, '') // удаляем разрешения и форматы
          .replace(/\.\d{4}\./g, '') // удаляем год
          .replace(/\./g, '') // заменяем точки на пустоту
          .trim(); // убираем пробелы с начала и конца строки
        }

        this.transliterate = function (text) {
        	const translitMap = {
        		'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z',
        		'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
        		'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
        		'ы': 'y', 'э': 'e', 'ю': 'yu', 'я': 'ya'
        	};
        	return text.split('').map(char => translitMap[char.toLowerCase()] || char).join('');
        }			


        this.findSimilarTitles = function (search_zero, search_one, search_two, videoItems) {
        	var _this = this;

        	// нормализация: разделители имён файлов -> пробелы
        	var norm = function (s) {
        		return (s || '').toLowerCase().replace(/[._\-\[\]()]+/g, ' ').replace(/\s+/g, ' ').trim();
        	};

        	// все варианты запроса: рус. название, оригинал, транслитерация
        	var queries = [search_zero, search_one, search_two, _this.transliterate(search_one || ''), _this.transliterate(search_zero || '')]
        		.map(norm).filter(function (q, i, arr) { return q && arr.indexOf(q) === i; });

        	var similarities = videoItems.map(function (item) {
        		var title = norm(_this.cleanTitle(item.title));
        		var best = 1;

        		for (var i = 0; i < queries.length; i++) {
        			var q = queries[i];
        			var score;
        			if (title.indexOf(q) > -1) {
        				score = 0;                                   // запрос целиком внутри имени файла
        			} else {
        				// нормируем на длину, иначе длинные имена релизов всегда проигрывают коротким
        				score = _this.levenshtein(title, q) / Math.max(title.length, q.length, 1);
        			}
        			if (score < best) best = score;
        		}

        		return { item: item, distance: best };
        	});

        	similarities.sort(function (a, b) { return a.distance - b.distance; });

        	// отсекаем заведомо чужое; если не осталось ничего - показываем три лучших
        	var relevant = similarities.filter(function (x) { return x.distance <= RELEVANCE_THRESHOLD; });
        	if (!relevant.length) relevant = similarities.slice(0, 3);

        	return relevant.slice(0, 10).map(function (x) { return x.item; });
        }


      /**
       * Поиск папки в массиве по ее имени
       */
        this.findFolderId = function (filesAndDirectories, folderName) {
				// console.log('Synology NAS', 'findFolderId', filesAndDirectories);
        	for (let folder of filesAndDirectories) {
        		if (folder.title === folderName) {
        			return folder.id;
        		}
        	}
        	return null;
        }			

      /**
       * Поиск нужной папки на DLNA-сервере, получение списка файлов в этой папке
       */
        this.getFilesInFolder = async function(nas_folder, search_zero, search_one, search_two) {
        	var _this = this;
			    let folder_id = 0; // начинаем с корневой папки
			    let folderNames = nas_folder.replace(/^\/+|\/+$/g, '').split('/'); // удаляем слеши в начале и конце пути и разделяем путь на части

			    let filesAndDirectories = [];
			    filesAndDirectories = await _this.getDLNAfiles(folder_id);

			    if (nas_folder !== '') {
			    	for (let folderName of folderNames) {
			    		folder_id = await _this.findFolderId(filesAndDirectories, folderName);
			    		if (folder_id === null) {
			    			Lampa.Noty.show(`DLNA: папка "${folderName}" не найдена`);
			    			console.error('Synology NAS', `DLNA: папка "${folderName}" не найдена`);
			    			return;
			    		}
			    		filesAndDirectories = await _this.getDLNAfiles(folder_id);
			    	}
			    }
			    var collected = await _this.collectRecursive(filesAndDirectories, MAX_DEPTH);
			    await _this.processFilesAndDirectories(collected, search_zero, search_one, search_two);
			  }			

      /**
       * Спуск во вложенные папки: оригинал смотрел только верхний уровень
       */
			  this.collectRecursive = async function (nodes, depth) {
			  	var _this = this;
			  	var items = nodes.filter(function (n) { return (n.type || '').indexOf('object.container') !== 0; });
			  	if (depth <= 0) return items;

			  	var folders = nodes.filter(function (n) { return (n.type || '').indexOf('object.container') === 0; });
			  	for (var i = 0; i < folders.length && i < MAX_FOLDERS; i++) {
			  		var children = await _this.getDLNAfiles(folders[i].id);
			  		items = items.concat(await _this.collectRecursive(children, depth - 1));
			  	}
			  	return items;
			  }

      /**
       * Обработка списка папок и файлов, формирование списка видеофайлов для отображения в Лампе
       */
			  this.processFilesAndDirectories = async function(filesAndDirectories, search_zero, search_one, search_two) {
				// console.log('Synology NAS', 'processFilesAndDirectories', filesAndDirectories);

				const videoItems = filesAndDirectories.filter(item => (item.type || '').indexOf('object.item.videoItem') === 0); // берем только видеофайлы

				const videoItemsBest3 = this.findSimilarTitles(search_zero, search_one, search_two, videoItems);

				results = {'player_links': {"movie": []}};

				results['player_links']["movie"] = videoItemsBest3.map(item => {
					var se = DLNA.episode(item); // сезон/серия из метаданных сервера, иначе из имени файла
					return {
						title: item.title,
						quality: item.resolution,
						link: this.getProxyURL(item.url),
						path: item.url, // без прокси: по нему считается общий с браузером ключ
						size: item.size,
						duration: item.duration,
						translation: item.title,
						season: se ? se.season : undefined,
						episode: se ? se.episode : undefined
					};
				});

				// серии карточки: id сериала известен из неё самой, искать по имени не нужно
				await this.loadEpisodes(results.player_links.movie);

				extractData(results);
				append(filtred());

				component.loading(false);
			}

      /**
       * Кадры, названия, рейтинг и даты серий для файлов этой карточки
       */
			this.loadEpisodes = async function (movies) {
				var movie = object.movie || {};
				var is_tv = !!(movie.number_of_seasons || movie.first_air_date || (movie.name && !movie.title));
				if (!movie.id || !is_tv) return;

				var need = {};
				movies.forEach(function (m) { if (m.season) need[m.season] = true; });

				var list = Object.keys(need).slice(0, 5);
				for (var i = 0; i < list.length; i++) {
					episodes[list[i]] = await TMDB.season(movie.id, list[i]);
				}
			};

			this.soapBrowse = DLNA.soapBrowse;

			this.getDLNAfiles = DLNA.browse;

			this.parseDLNAXmlResponse = DLNA.parseXml;

      /**
       * Начать поиск
       * @param {Object} _object 
       */
      this.search = function (_object) {
        // console.log('Synology NAS', 'synology.search', _object);
      	
      	var nasServerFolder = Lampa.Storage.get('synology_nas_server_folder');

      	this.getFilesInFolder(nasServerFolder, _object.search, _object.search_one, _object.search_two);   
      };


      /**
       * Сброс фильтра
       */
      this.reset = function () {
      	component.reset();
      	choice = {
      		season: 0,
      		voice: 0,
      		voice_name: ''
      	};
      	extractData(results);
      	component.saveChoice(choice);
      };

      /**
       * Применить фильтр
       * @param {*} type 
       * @param {*} a 
       * @param {*} b 
       */
      this.filter = function (type, a, b) {
      	choice[a.stype] = b.index;
      	if (a.stype == 'voice') choice.voice_name = filter_items.voice[b.index];
      	component.reset();
      	extractData(results);
      	component.saveChoice(choice);
      };

      /**
       * Уничтожить
       */
      this.destroy = function () {
      	network.clear();
      	results = null;
      };

      /**
       * Получить информацию о фильме
       * @param {Arrays} data
       */
      function extractData(data) {
      	// console.log('Synology NAS', 'extractData in', data);
      	extract = {};
      	data.player_links.movie.forEach((movie, index) => {
				    const id = (index + 1).toString(); // convert index to string for keys
				    extract[id] = {
				    	file: movie.link, 
				    	translation: movie.translation,
				    	quality: movie.quality
				    };
				  });

        // console.log('Synology NAS', 'extractData out', extract);
      }


      /**
       * Найти поток
       * @param {Object} element
       * @returns string
       */
      function getFile(element) {
      	// console.log('Synology NAS', 'getFile in', element, extract);

      	var file = '';
      	var translat = extract[element.translation];
      	if (translat) {
        	// console.log('Synology NAS', 'getFail translat', translat);
      		file = {
      			file: translat.file,
      			quality: {
      				"480p": translat.file
      			}
      		};        	
      	}
        // console.log('Synology NAS', 'getFile out', file);
      	return file;
      }


      /**
       * Отфильтровать файлы
       * @returns array
       */
      function filtred() {
      	// console.log('Synology NAS', 'filtred results', results);
      	var filtred = [];

        // console.log('Synology NAS', 'filtred filtred', filtred);
      	results.player_links.movie.forEach((movie, index) => {
					const id = (index + 1).toString(); // convert index to string for keys
					filtred.push({
						title: movie.translation,
						translation: id,
						quality: movie.quality,
						path: movie.path,
						size: movie.size,
						duration: movie.duration,
						season: movie.season,
						episode: movie.episode
					});
				});

      	return filtred;
      }


      /**
       * Добавить видео
       * @param {Array} items 
       */
      function append(items) {
      	// console.log('Synology NAS', 'append', items);

      	component.reset();
      	var viewed = Lampa.Storage.cache('online_view', 5000, []);
      	var last_episode = component.getLastEpisode(items);

        /**
         * Что показать в плеере: название серии, если оно найдено, иначе имя файла
         */
      	var playerTitle = function (el) {
      		var data = el.season && episodes[el.season] ? episodes[el.season][el.episode] : null;
      		if (data && data.name) return episodeTitle(object.movie.title || object.movie.name, el.season, el.episode, data.name);

      		return el.season ? el.title : object.movie.title + ' / ' + el.title;
      	};

      	items.forEach(function (element) {
      		// имя файла оставляем как есть - оно информативнее, чем 'S1 / Серия 2'
      		element.info = element.season ? ' / S' + element.season + 'E' + element.episode : '';
      		if (element.season) {
      			element.translate_episode_end = last_episode;
      			element.translate_voice = VOICE;
      		}
      		var hash = Lampa.Utils.hash(element.season ? [element.season, element.episode, object.movie.original_title].join('') : object.movie.original_title + element.title); // + title: иначе все файлы карточки делят один таймкод
      		var hash_file = Lampa.Utils.hash(element.season ? [element.season, element.episode, object.movie.original_title, VOICE].join('') : object.movie.original_title + element.title);
      		var hash_path = element.path ? DLNA.fileHash(element) : ''; // ключ того же файла на странице DLNA

      		if (hash_path) {
      			// карточка - единственное место, где известны оба ключа одного файла
      			DLNA.linkHash(hash_path, hash, hash_file);
      			DLNA.syncTimeline(hash, hash_path);
      			DLNA.syncViewed(hash_file, hash_path);
      			viewed = Lampa.Storage.cache('online_view', 5000, []);
      		}

      		var view = Lampa.Timeline.view(hash);
      		element.timeline = view;

      		var ep = element.season && episodes[element.season] ? episodes[element.season][element.episode] : null;
      		var item;

      		if (ep) {
      			item = buildEpisodeItem({
      				number: element.episode,
      				title: ep.name || element.title,
      				still: TMDB.image(ep.still, 'w300'),
      				rating: ep.rating,
      				date: ep.date,
      				time: element.duration ? String(element.duration).split('.')[0] : '',
      				quality: element.quality,
      				size: DLNA.humanSize(element.size),
      				warning: runtimeWarning(element.duration, ep.runtime),
      				timeline: view
      			});
      		} else {
      			item = Lampa.Template.get('synology_nas', element);
      			item.addClass('video--stream');
      			item.append(Lampa.Timeline.render(view));
      			if (Lampa.Timeline.details) {
      				item.find('.online__quality').append(Lampa.Timeline.details(view, ' / '));
      			}
      			if (viewed.indexOf(hash_file) !== -1) item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
      		}
      		item.on('hover:enter', function () {
      			if (object.movie.id) Lampa.Favorite.add('history', object.movie, 100);
            // console.log('Synology NAS', 'hover:enter', element);
      			var extra = getFile(element);
      			if (extra.file) {
      				var playlist = [];
      				var first = {
      					url: extra.file,
                // quality: extra.quality,
      					timeline: view,
      					title: playerTitle(element)
      				};

      				if (element.season) {
      					items.forEach(function (elem) {
      						var ex = getFile(elem);
      						playlist.push({
      							title: playerTitle(elem),
      							url: ex.file,
                    // quality: ex.quality,
      							timeline: elem.timeline
      						});
      					});
      				} else {
      					playlist.push(first);
      				}
      				if (playlist.length > 1) first.playlist = playlist;
              // console.log('Synology NAS', 'append first', first);
              // console.log('Synology NAS', 'append playlist', playlist);
      				Lampa.Player.play(first);
      				Lampa.Player.playlist(playlist);
      				if (viewed.indexOf(hash_file) == -1) {
      					viewed.push(hash_file);
      					// у нативной строки серии роль отметки играет полоса прогресса
      					if (!ep) item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
      					Lampa.Storage.set('online_view', viewed);
      				}
      				DLNA.syncViewed(hash_file, hash_path);
      			} else Lampa.Noty.show(Lampa.Lang.translate('online_nolink'));
      		});
      		component.append(item);
      	});
      	component.start(true);


      }
    }

    function component(object) {
    	var network = new Lampa.Reguest();
    	var scroll = new Lampa.Scroll({
    		mask: true,
    		over: true
    	});
    	var files = new Lampa.Files(object);
    	var filter = new Lampa.Filter(object);
    	var balanser = Lampa.Storage.get('synology_nas_balanser', 'synology');
    	var last_bls = Lampa.Storage.cache('online_last_balanser', 200, {});
    	if (last_bls[object.movie.id]) {
    		balanser = last_bls[object.movie.id];
    	}
    	var sources = {
    		synology: new synology(this, object),
    	};
    	var last;
    	var last_filter;
    	var extended;
    	var selected_id;
    	var filter_translate = {
    		season: Lampa.Lang.translate('torrent_serial_season'),
    		voice: Lampa.Lang.translate('torrent_parser_voice'),
    		source: Lampa.Lang.translate('settings_rest_source')
    	};
    	var filter_sources = ['synology'];
    	var kiposk_sources = [];

    	if (filter_sources.indexOf(balanser) == -1) {
    		balanser = 'synology';
    		Lampa.Storage.set('synology_nas_balanser', 'synology');
    	}
    	scroll.body().addClass('torrent-list');
    	function minus() {
    		scroll.minus(window.innerWidth > 580 ? false : files.render().find('.files__left'));
    	}
    	window.addEventListener('resize', minus, false);
    	minus();

      /**
       * Подготовка
       */
    	this.create = function () {
    		var _this = this;
    		this.activity.loader(true);
    		filter.onSearch = function (value) {
    			Lampa.Activity.replace({
    				search: value,
    				clarification: true
    			});
    		};
    		files.append(scroll.render());
    		scroll.append(filter.render());
    		this.search();
    		return this.render();
    	};

      /**
       * Начать поиск
       */
    	this.search = function () {
    		this.activity.loader(true);
    		this.reset();
    		this.find();
    	};
    	this.find = function () {
    		sources['synology'].search(object);
    	};
    	this.saveChoice = function (choice) {
    		var data = Lampa.Storage.cache('synology_nas_choice_' + balanser, 500, {});
    		data[selected_id || object.movie.id] = choice;
    		Lampa.Storage.set('synology_nas_choice_' + balanser, data);
    	};

      /**
       * Очистить список файлов
       */
    	this.reset = function () {
    		last = false;
    		scroll.render().find('.empty').remove();
    		filter.render().detach();
    		scroll.clear();
    		scroll.append(filter.render());
    	};

      /**
       * Загрузка
       */
    	this.loading = function (status) {
    		if (status) this.activity.loader(true);else {
    			this.activity.loader(false);
    			this.activity.toggle();
    		}
    	};


      /**
       * Добавить файл
       */
    	this.append = function (item) {
    		item.on('hover:focus', function (e) {
    			last = e.target;
    			scroll.update($(e.target), true);
    		});
    		scroll.append(item);
    	};

      /**
       * Показать пустой результат
       */
    	this.empty = function (msg) {
    		var empty = Lampa.Template.get('list_empty');
    		if (msg) empty.find('.empty__descr').text(msg);
    		scroll.append(empty);
    		this.loading(false);
    	};

      /**
       * Показать пустой результат по ключевому слову
       */
    	this.emptyForQuery = function (query) {
    		this.empty(Lampa.Lang.translate('online_query_start') + ' (' + query + ') ' + Lampa.Lang.translate('synology_nas_query_end'));
    	};
    	this.getLastEpisode = function (items) {
    		var last_episode = 0;
    		items.forEach(function (e) {
    			if (typeof e.episode !== 'undefined') last_episode = Math.max(last_episode, parseInt(e.episode));
    		});
    		return last_episode;
    	};

      /**
       * Начать навигацию по файлам
       */
    	this.start = function (first_select) {
        if (Lampa.Activity.active().activity !== this.activity) return; //обязательно, иначе наблюдается баг, активность создается но не стартует, в то время как компонент загружается и стартует самого себя.

        if (first_select) {
        	var last_views = scroll.render().find('.selector.online').find('.torrent-item__viewed').parent().last();
        	if (object.movie.number_of_seasons && last_views.length) last = last_views.eq(0)[0];else last = scroll.render().find('.selector').eq(3)[0];
        }
        Lampa.Background.immediately(Lampa.Utils.cardImgBackground(object.movie));
        Lampa.Controller.add('content', {
        	toggle: function toggle() {
        		Lampa.Controller.collectionSet(scroll.render(), files.render());
        		Lampa.Controller.collectionFocus(last || false, scroll.render());
        	},
        	up: function up() {
        		if (Navigator.canmove('up')) {
        			if (scroll.render().find('.selector').slice(3).index(last) == 0 && last_filter) {
        				Lampa.Controller.collectionFocus(last_filter, scroll.render());
        			} else Navigator.move('up');
        		} else Lampa.Controller.toggle('head');
        	},
        	down: function down() {
        		Navigator.move('down');
        	},
        	right: function right() {
        		if (Navigator.canmove('right')) Navigator.move('right');else filter.show(Lampa.Lang.translate('title_filter'), 'filter');
        	},
        	left: function left() {
        		if (Navigator.canmove('left')) Navigator.move('left');else Lampa.Controller.toggle('menu');
        	},
        	back: this.back
        });
        Lampa.Controller.toggle('content');
      };
      this.render = function () {
      	return files.render();
      };
      this.back = function () {
      	Lampa.Activity.backward();
      };
      this.pause = function () {};
      this.stop = function () {};
      this.destroy = function () {
      	network.clear();
      	files.destroy();
      	scroll.destroy();
      	network = null;
      	sources.synology.destroy();
      	window.removeEventListener('resize', minus);
      };
    }

    /**
     * Очередь загрузки превью: список может быть на сотни файлов,
     * а миниатюры отдаёт тот же самый домашний сервер
     */
    var thumb_queue = [];
    var thumb_active = 0;

    function loadThumbs() {
    	while (thumb_active < THUMB_PARALLEL && thumb_queue.length) {
    		startThumb(thumb_queue.shift());
    	}
    }

    function startThumb(task) {
    	var done = false;
    	// imgLoad при ошибке подставляет свою заглушку, и та потом дёргает onload - считаем задачу один раз
    	var finish = function () {
    		if (done) return;
    		done = true;
    		thumb_active--;
    		loadThumbs();
    	};

    	thumb_active++;
    	Lampa.Utils.imgLoad(task.img, task.src, function (img) {
    		img.classList.add('loaded');
    		if (task.onload) task.onload();
    		finish();
    	}, function (img) {
    		img.style.display = 'none'; // под картинкой остаётся иконка, заглушка imgLoad тут не нужна
    		finish();
    	});
    }

    function queueThumb(img, src, onload) {
    	thumb_queue.push({ img: img, src: src, onload: onload });
    	loadThumbs();
    }

    /**
     * Длительность файла против длительности серии в TMDB
     *
     * Заметное расхождение значит, что файл не тот: сдвинутая нумерация,
     * склейка двух серий, другая версия. Стоит ноль запросов - длительность
     * есть и у файла, и в уже полученном ответе сезона.
     */
    function runtimeWarning(duration, runtime) {
    	if (!runtime) return '';

    	var minutes = Math.round(DLNA.durationSeconds(duration) / 60);
    	if (!minutes) return '';
    	if (Math.abs(minutes - runtime) <= Math.max(3, runtime * 0.1)) return '';

    	return '<span class="dlna-warn">⚠ ' + minutes + ' ≠ ' + runtime + ' ' + Lampa.Lang.translate('dlna_minutes') + '</span>';
    }

    /**
     * Заголовок для плеера: "Игра престолов / S01E03 · Лорд Сноу" вместо имени файла
     */
    function episodeTitle(show, season, episode, name) {
    	var label = 'S' + ('0' + season).slice(-2) + 'E' + ('0' + episode).slice(-2);
    	return (show ? show + ' / ' : '') + label + (name ? ' · ' + name : '');
    }

    function dateHuman(date) {
    	if (!date) return '';
    	var parsed = Lampa.Utils.parseTime ? Lampa.Utils.parseTime(date) : null;
    	return (parsed && parsed.full) ? parsed.full : date;
    }

    /**
     * Строка в нативном стиле серии: кадр с номером слева, название, таймлайн, рейтинг и дата
     *
     * Используется и на странице DLNA, и в списке DLNA на карточке сериала,
     * поэтому берём шаблон ядра - вид совпадает со штатным списком серий.
     *
     * @param {Object} data {number, title, still, rating, date, time, quality, size, timeline}
     */
    function buildEpisodeItem(data) {
    	addBrowserStyle(); // строка используется и на карточке, где стили ещё не подключены

    	var item = Lampa.Template.get('season_episode', {
    		title: data.title || '',
    		time: data.time || '',
    		info: '',
    		quality: data.quality || ''
    	});

    	item.addClass('dlna-episode'); // метка своих строк: по ней навешиваются отступы и цвета

    	var box = item.find('.season-episode__img');
    	box.find('.season-episode__loader').remove(); // картинки грузим своей очередью
    	box.append('<div class="season-episode__episode-number">' + ('0' + data.number).slice(-2) + '</div>');

    	if (data.still) {
    		queueThumb(box.find('img')[0], data.still, function () {
    			box.addClass('season-episode__img--loaded');
    		});
    	}

    	var split = '<span class="season-episode-split">●</span>';
    	var info = [];
    	if (data.rating) info.push('★ ' + parseFloat(data.rating).toFixed(1));
    	if (data.date) info.push(dateHuman(data.date));
    	if (data.size) info.push(data.size);
    	if (data.warning) info.push(data.warning);

    	var info_line = item.find('.season-episode__info').html(info.join(split));

    	// прогресс просмотра заменяет звёздочку - как в штатном списке серий
    	if (data.timeline) item.find('.season-episode__timeline').append(Lampa.Timeline.render(data.timeline));

    	// "Просмотрено - 10 м. из 46 м. / 23%" видно прямо в списке, заходить в серию не нужно.
    	// Ядро само прячет строку, когда прогресса нет, и само обновляет её по data-hash
    	if (data.timeline && Lampa.Timeline.details) {
    		info_line.append(Lampa.Timeline.details(data.timeline, info.length ? split : ''));
    	}

    	return item;
    }

    function addBrowserStyle() {
    	if ($('#dlna-browser-style').length) return;

    	// строка начинается узкой, как раньше; широкой становится, когда загрузилось первое превью
    	$('<style id="dlna-browser-style">'
    		+ '.dlna-thumb{position:absolute;left:0;top:-0.3em;width:2.4em;height:2.4em;border-radius:0.2em;overflow:hidden;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;transition:width .2s}'
    		+ '.dlna-thumb svg{width:1.5em;height:1.5em}'
    		+ '.dlna-thumb__img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .2s}'
    		+ '.dlna-thumb__img.loaded{opacity:1}'
    		+ '.dlna-item .online__title,.dlna-item .online__quality{padding-left:3.2em;transition:padding-left .2s}'
    		+ '.dlna-wide .dlna-thumb{width:4.2em}'
    		+ '.dlna-wide .dlna-item .online__title,.dlna-wide .dlna-item .online__quality{padding-left:5em}'
    		// правила своих строк не должны задевать штатный список серий, поэтому всё через .dlna-episode
    		+ '.dlna-episode{margin-bottom:1em}'
    		+ '.dlna-episode .season-episode-split{margin:0 0.6em}'
    		+ '.dlna-episode .dlna-warn{color:#ffb74d}'
    		+ '</style>').appendTo('head');
    }

    /**
     * Отдельная страница: обзор DLNA-сервера
     *
     * Без folder_id - главная страница: собирает папки и отдельные файлы
     * из ветки BROWSER_ROOT и сортирует их по дате последнего просмотра.
     * С folder_id - обычный список содержимого папки.
     */
    function browser(object) {
    	var scroll = new Lampa.Scroll({
    		mask: true,
    		over: true
    	});
    	var last;
    	var destroyed = false;
    	var rows = [];     // компактные строки, чтобы дорисовать в них превью, когда придёт ответ TMDB
    	var show = null;   // сериал/фильм, с которым сопоставлена текущая папка
    	var seasons = {};  // серии по сезонам из TMDB

    	scroll.body().addClass('torrent-list');

    	function resize() {
    		if (Lampa.Layer && Lampa.Layer.update) Lampa.Layer.update(scroll.render());
    	}

    	this.create = function () {
    		scroll.minus(); // без этого у скролла нет высоты и список не прокручивается
    		window.addEventListener('resize', resize, false);
    		this.activity.loader(true);
    		this.build();
    		return this.render();
    	};

      /**
       * Загрузить и показать содержимое
       */
    	this.build = async function () {
    		var folders = [], files = [];

    		try {
    			if (object.folder_id) {
    				var nodes = await DLNA.browse(object.folder_id);
    				folders = nodes.filter(DLNA.isFolder);
    				files = nodes.filter(function (n) { return !DLNA.isFolder(n); });
    			} else {
    				var root = Lampa.Storage.get('dlna_browser_root', BROWSER_ROOT);
    				var root_id = await DLNA.resolvePath(root);

    				if (root_id === null) {
    					Lampa.Noty.show(Lampa.Lang.translate('dlna_browser_noroot') + ': ' + root);
    					root_id = '0';
    				}
    				var tree = await DLNA.collect(root_id, TREE_DEPTH);
    				folders = tree.folders;
    				files = tree.files;
    			}
    		} catch (e) {
    			console.error('DLNA', 'browse', e);
    		}

    		if (destroyed) return;
    		if (!folders.length && !files.length) return this.empty();

    		// сопоставляем папку с сериалом до отрисовки: иначе строки перестроятся уже на глазах
    		if (object.folder_id && files.length) await this.matchShow(files);
    		if (destroyed) return;

    		var _this = this;
    		// на главной сверху то, что смотрели недавно; внутри папки - обычный порядок по имени
    		var sort = object.folder_id ? this.sortByTitle : this.sortByView;

    		addBrowserStyle();

    		sort(folders).forEach(function (node) {
    			_this.appendFolder(node);
    		});

    		// плейлист по всем проигрываемым файлам списка - чтобы работал переход к следующему
    		var sorted_files = sort(files);
    		var playable = sorted_files.filter(function (n) { return (DLNA.isVideo(n) || DLNA.isAudio(n)) && n.url; });

    		sorted_files.forEach(function (node) {
    			_this.appendFile(node, playable);
    		});

    		this.activity.loader(false);
    		resize();
    		this.start(true);
    		this.activity.toggle();

    		this.loadPreviews(); // асинхронно, список уже показан
    	};

      /**
       * Сопоставить папку с сериалом и подтянуть серии тех сезонов, что реально лежат в папке
       */
    	this.matchShow = async function (files) {
    		var ctx = object.folder_title || object.root_title || '';
    		if (!ctx) return;

    		show = await TMDB.match(ctx);
    		if (destroyed || !show || show.type !== 'tv') return;

    		var need = {};
    		files.forEach(function (node) {
    			var se = DLNA.episode(node);
    			if (se) need[se.season] = true;
    		});

    		var list = Object.keys(need).slice(0, 5); // папка со всеми сезонами сразу не должна тормозить открытие
    		for (var i = 0; i < list.length; i++) {
    			var data = await TMDB.season(show.id, list[i]);
    			if (destroyed) return;

    			if (this.trustSeason(files, list[i], data)) seasons[list[i]] = data;
    			else console.log('DLNA', 'сопоставление с TMDB отклонено, сезон', list[i], '- состав папки не сходится с сезоном');
    		}
    	};

      /**
       * Похоже ли, что папка - это именно этот сезон
       *
       * Ошибочное сопоставление подставит чужие названия серий, и заметить это
       * трудно. Файлов меньше, чем серий - нормально (скачано не всё), а вот
       * лишние файлы или номера, которых в сезоне нет - признак чужого сериала.
       */
    	this.trustSeason = function (files, season, episodes) {
    		var total = Object.keys(episodes).length;
    		if (!total) return false;

    		var numbers = [];
    		files.forEach(function (node) {
    			var se = DLNA.episode(node);
    			if (se && String(se.season) === String(season)) numbers.push(se.episode);
    		});

    		if (!numbers.length || numbers.length > total) return false;

    		return numbers.every(function (n) { return !!episodes[n]; });
    	};

      /**
       * Данные серии из TMDB для файла, если папка сопоставилась с сериалом
       */
    	this.episodeInfo = function (node) {
    		if (!show || show.type !== 'tv') return null;

    		var se = DLNA.episode(node);
    		if (!se) return null;

    		var data = seasons[se.season] && seasons[se.season][se.episode];
    		return data ? { season: se.season, number: se.episode, data: data } : null;
    	};

      /**
       * Что показать в плеере: название серии, если оно найдено, иначе имя файла
       */
    	this.playerTitle = function (node) {
    		var episode = this.episodeInfo(node);
    		if (!episode || !episode.data.name) return node.title;

    		return episodeTitle(show && show.name, episode.season, episode.number, episode.data.name);
    	};

    	this.sortByTitle = function (list) {
    		return list.slice().sort(function (a, b) {
    			return (a.title || '').localeCompare(b.title || '', undefined, { numeric: true, sensitivity: 'base' });
    		});
    	};

    	this.sortByView = function (list) {
    		return list.slice().sort(function (a, b) {
    			var ta = DLNA.viewTime(a.title);
    			var tb = DLNA.viewTime(b.title);
    			if (ta !== tb) return tb - ta; // непросмотренные (0) уходят вниз и там сортируются по имени
    			return (a.title || '').localeCompare(b.title || '', undefined, { numeric: true, sensitivity: 'base' });
    		});
    	};

    	this.appendFolder = function (node) {
    		var descr = [
    			node.childCount ? node.childCount + ' ' + Lampa.Lang.translate('dlna_browser_items') : '',
    			DLNA.viewDate(node.title)
    		].filter(function (v) { return v; }).join(' / ');

    		var item = Lampa.Template.get('dlna_thumb', {
    			title: node.title,
    			quality: descr,
    			info: ''
    		});
    		this.thumbBox(item, node, ICON_FOLDER, true);

    		item.on('hover:enter', function () {
    			Lampa.Activity.push({
    				url: '',
    				title: node.title || Lampa.Lang.translate('dlna_browser_title'),
    				component: 'dlna_browser',
    				folder_id: node.id,
    				folder_title: node.title,
    				root_title: object.root_title || node.title, // папка, через которую вошли с главной
    				page: 1
    			});
    		});
    		this.append(item);
    	};

    	this.appendFile = function (node, playlist_source) {
    		var size = DLNA.humanSize(node.size);
    		var duration = node.duration ? String(node.duration).split('.')[0] : '';
    		var descr = [size, node.resolution, duration].filter(function (v) { return v; }).join(' / ');

    		var url = node.url ? DLNA.getProxyURL(node.url) : '';
    		var can_play = (DLNA.isVideo(node) || DLNA.isAudio(node)) && url;
    		var hash = DLNA.fileHash(node);
    		var link = DLNA.linkedHash(hash); // ключи этого же файла на карточке фильма, если он там открывался

    		if (link) {
    			DLNA.syncTimeline(hash, link.t);
    			DLNA.syncViewed(hash, link.v);
    		}

    		var viewed = Lampa.Storage.cache('online_view', 5000, []);
    		var view = Lampa.Timeline.view(hash);
    		var episode = this.episodeInfo(node);
    		var item;

    		if (episode) {
    			item = buildEpisodeItem({
    				number: episode.number,
    				title: episode.data.name || node.title,
    				still: TMDB.image(episode.data.still, 'w300'),
    				rating: episode.data.rating,
    				date: episode.data.date,
    				time: duration,
    				quality: node.resolution,
    				size: size,
    				warning: runtimeWarning(node.duration, episode.data.runtime),
    				timeline: view
    			});
    		} else {
    			item = Lampa.Template.get('dlna_thumb', {
    				title: node.title,
    				quality: descr,
    				info: ''
    			});
    			this.thumbBox(item, node, ICON_PLAY, false);
    			item.addClass('video--stream');

    			if (DLNA.isVideo(node)) {
    				item.append(Lampa.Timeline.render(view));
    				if (Lampa.Timeline.details) item.find('.online__quality').append(Lampa.Timeline.details(view, ' / '));
    			}
    			if (viewed.indexOf(hash) !== -1) item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
    		}

    		var _this = this;

    		item.on('hover:enter', function () {
    			if (!can_play) return Lampa.Noty.show(Lampa.Lang.translate('dlna_browser_cantplay'));

    			var playlist = playlist_source.map(function (n) {
    				return {
    					title: _this.playerTitle(n),
    					url: DLNA.getProxyURL(n.url),
    					timeline: Lampa.Timeline.view(DLNA.fileHash(n))
    				};
    			});
    			var first = {
    				title: _this.playerTitle(node),
    				url: url,
    				timeline: view
    			};
    			if (playlist.length > 1) first.playlist = playlist;

    			Lampa.Player.play(first);
    			Lampa.Player.playlist(playlist.length ? playlist : [first]);

    			// отметка времени просмотра: по ней сортируется главная страница
    			DLNA.markView(node.title, object.folder_title, object.root_title);

    			if (viewed.indexOf(hash) == -1) {
    				viewed.push(hash);
    				// у нативной строки серии роль отметки играет полоса прогресса
    				if (!episode) item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
    				Lampa.Storage.set('online_view', viewed);
    			}
    			if (link) DLNA.syncViewed(hash, link.v);
    		});
    		this.append(item);
    	};

      /**
       * Превью в строке: иконка видна сразу, картинка проявляется поверх неё после загрузки
       */
    	this.thumbBox = function (item, node, icon, is_folder) {
    		var box = item.find('.dlna-thumb');
    		box.append(icon);
    		item.addClass('dlna-item');

    		rows.push({ node: node, item: item, box: box, folder: is_folder });

    		this.setThumb(box, DLNA.thumb(node)); // если сервер превью всё-таки отдаёт, оно приоритетнее
    	};

    	this.setThumb = function (box, src) {
    		if (!src || box.find('img').length) return;

    		var img = $('<img class="dlna-thumb__img" />');
    		box.append(img);

    		queueThumb(img[0], src, function () {
    			// первая же загрузившаяся картинка расширяет строки под кадр 16:9
    			if (!destroyed) scroll.body().addClass('dlna-wide');
    		});
    	};

      /**
       * Постеры папок, кадры и названия серий из TMDB - локальный сервер их не отдаёт
       */
    	this.loadPreviews = async function () {
    		var lookups = 0;

    		// строки, для которых нативный вид серии не подошёл: папки и несопоставленные файлы
    		for (var i = 0; i < rows.length; i++) {
    			var row = rows[i];
    			if (destroyed) return;
    			if (row.box.find('img').length) continue; // превью уже дал сервер

    			var src = '';

    			// файл в папке фильма забирает постер этого фильма, искать по имени файла незачем
    			if (!row.folder && show && show.type === 'movie') src = TMDB.image(show.poster, 'w300');

    			if (!src) {
    				if (lookups >= TMDB_MAX_LOOKUP) continue; // на пёстрой папке не устраиваем шквал поиска
    				lookups++;

    				var match = await TMDB.match(row.node.title);
    				if (destroyed) return;
    				if (match) src = TMDB.image(match.poster, 'w300');
    			}

    			this.setThumb(row.box, src);
    		}
    	};

    	this.append = function (item) {
    		item.on('hover:focus', function (e) {
    			last = e.target;
    			scroll.update($(e.target), true);
    		});
    		scroll.append(item);
    	};

    	this.empty = function () {
    		var empty = Lampa.Template.get('list_empty');
    		empty.find('.empty__descr').text(Lampa.Lang.translate('dlna_browser_empty'));
    		scroll.append(empty);
    		this.activity.loader(false);
    		resize();
    		this.start(true);
    		this.activity.toggle();
    	};

    	this.start = function (first_select) {
    		if (Lampa.Activity.active().activity !== this.activity) return;

    		if (first_select && !last) last = scroll.render().find('.selector').eq(0)[0];

    		Lampa.Controller.add('content', {
    			toggle: function toggle() {
    				Lampa.Controller.collectionSet(scroll.render());
    				Lampa.Controller.collectionFocus(last || false, scroll.render());
    			},
    			up: function up() {
    				if (Navigator.canmove('up')) Navigator.move('up');else Lampa.Controller.toggle('head');
    			},
    			down: function down() {
    				Navigator.move('down');
    			},
    			right: function right() {
    				Navigator.move('right');
    			},
    			left: function left() {
    				if (Navigator.canmove('left')) Navigator.move('left');else Lampa.Controller.toggle('menu');
    			},
    			back: this.back
    		});
    		Lampa.Controller.toggle('content');
    	};

    	this.render = function () {
    		return scroll.render();
    	};
    	this.back = function () {
    		Lampa.Activity.backward();
    	};
    	this.pause = function () {};
    	this.stop = function () {};
    	this.destroy = function () {
    		destroyed = true;
    		rows = [];
    		thumb_queue = []; // недогруженные превью закрытой страницы уже не нужны
    		if (TMDB.net) TMDB.net.clear();
    		window.removeEventListener('resize', resize);
    		scroll.destroy();
    	};
    }

    if (!Lampa.Lang) {
    	var lang_data = {};
    	Lampa.Lang = {
    		add: function add(data) {
    			lang_data = data;
    		},
    		translate: function translate(key) {
    			return lang_data[key] ? lang_data[key].ru : key;
    		}
    	};
    }
    Lampa.Lang.add({
    	online_nolink: {
    		ru: 'Не удалось извлечь ссылку',
    		uk: 'Неможливо отримати посилання',
    		en: 'Failed to fetch link',
    		zh: '获取链接失败',
    		bg: 'Не може да се извлече връзката'
    	},
    	synology_nas_balanser: {
    		ru: 'Балансер',
    		uk: 'Балансер',
    		en: 'Balancer',
    		zh: '平衡器',
    		bg: 'Балансър'
    	},
    	online_query_start: {
    		ru: 'По запросу',
    		uk: 'На запит',
    		en: 'On request',
    		zh: '根据要求',
    		bg: 'По запитване'
    	},
    	synology_nas_query_end: {
    		ru: 'нет результатов',
    		uk: 'немає результатів',
    		en: 'no results',
    		zh: '没有结果',
    		bg: 'няма резултати'
    	},
    	synology_nas_title: {
    		ru: 'DLNA',
    		uk: 'DLNA',
    		en: 'DLNA',
    		zh: 'DLNA',
    		bg: 'DLNA'
    	},
    	dlna_browser_title: {
    		ru: 'DLNA сервер',
    		uk: 'DLNA сервер',
    		en: 'DLNA server',
    		zh: 'DLNA 服务器',
    		bg: 'DLNA сървър'
    	},
    	dlna_browser_items: {
    		ru: 'эл.',
    		uk: 'ел.',
    		en: 'items',
    		zh: '项',
    		bg: 'ел.'
    	},
    	dlna_browser_empty: {
    		ru: 'Папка пуста или сервер недоступен',
    		uk: 'Папка порожня або сервер недоступний',
    		en: 'Folder is empty or server is unavailable',
    		zh: '文件夹为空或服务器不可用',
    		bg: 'Папката е празна или сървърът е недостъпен'
    	},
    	dlna_minutes: {
    		ru: 'мин',
    		uk: 'хв',
    		en: 'min',
    		zh: '分钟',
    		bg: 'мин'
    	},
    	dlna_browser_noroot: {
    		ru: 'Папка не найдена, открыт корень сервера',
    		uk: 'Папку не знайдено, відкрито корінь сервера',
    		en: 'Folder not found, opening server root',
    		zh: '未找到文件夹，打开服务器根目录',
    		bg: 'Папката не е намерена, отворен е коренът на сървъра'
    	},
    	dlna_browser_cantplay: {
    		ru: 'Этот файл нельзя воспроизвести',
    		uk: 'Цей файл неможливо відтворити',
    		en: 'This file cannot be played',
    		zh: '无法播放此文件',
    		bg: 'Този файл не може да бъде възпроизведен'
    	}
    });
    function resetTemplates() {
    	Lampa.Template.add('synology_nas', "<div class=\"online selector\">\n        <div class=\"online__body\">\n            <div style=\"position: absolute;left: 0;top: -0.3em;width: 2.4em;height: 2.4em\">\n                <svg style=\"height: 2.4em; width:  2.4em;\" viewBox=\"0 0 128 128\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n                    <circle cx=\"64\" cy=\"64\" r=\"56\" stroke=\"white\" stroke-width=\"16\"/>\n                    <path d=\"M90.5 64.3827L50 87.7654L50 41L90.5 64.3827Z\" fill=\"white\"/>\n                </svg>\n            </div>\n            <div class=\"online__title\" style=\"padding-left: 2.1em;\">{title}</div>\n            <div class=\"online__quality\" style=\"padding-left: 3.4em;\">{quality}{info}</div>\n        </div>\n    </div>");
    	Lampa.Template.add('synology_nas_folder', "<div class=\"online selector\">\n        <div class=\"online__body\">\n            <div style=\"position: absolute;left: 0;top: -0.3em;width: 2.4em;height: 2.4em\">\n                <svg style=\"height: 2.4em; width:  2.4em;\" viewBox=\"0 0 128 112\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n                    <rect y=\"20\" width=\"128\" height=\"92\" rx=\"13\" fill=\"white\"/>\n                    <path d=\"M29.9963 8H98.0037C96.0446 3.3021 91.4079 0 86 0H42C36.5921 0 31.9555 3.3021 29.9963 8Z\" fill=\"white\" fill-opacity=\"0.23\"/>\n                    <rect x=\"11\" y=\"8\" width=\"106\" height=\"76\" rx=\"13\" fill=\"white\" fill-opacity=\"0.51\"/>\n                </svg>\n            </div>\n            <div class=\"online__title\" style=\"padding-left: 2.1em;\">{title}</div>\n            <div class=\"online__quality\" style=\"padding-left: 3.4em;\">{quality}{info}</div>\n        </div>\n    </div>");

    	// вариант с кадром-превью: используется, только если сервер отдал миниатюры
    	Lampa.Template.add('dlna_thumb', "<div class=\"online selector\">\n        <div class=\"online__body\">\n            <div class=\"dlna-thumb\"></div>\n            <div class=\"online__title\">{title}</div>\n            <div class=\"online__quality\">{quality}{info}</div>\n        </div>\n    </div>");
    }
    var button = "<div class=\"full-start__button selector view--online\" data-subtitle=\"v0.0.2\">\n    <svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" xmlns:svgjs=\"http://svgjs.com/svgjs\" version=\"1.1\" width=\"512\" height=\"512\" x=\"0\" y=\"0\" viewBox=\"0 0 30.051 30.051\" style=\"enable-background:new 0 0 512 512\" xml:space=\"preserve\" class=\"\">\n    <g xmlns=\"http://www.w3.org/2000/svg\">\n        <path d=\"M19.982,14.438l-6.24-4.536c-0.229-0.166-0.533-0.191-0.784-0.062c-0.253,0.128-0.411,0.388-0.411,0.669v9.069   c0,0.284,0.158,0.543,0.411,0.671c0.107,0.054,0.224,0.081,0.342,0.081c0.154,0,0.31-0.049,0.442-0.146l6.24-4.532   c0.197-0.145,0.312-0.369,0.312-0.607C20.295,14.803,20.177,14.58,19.982,14.438z\" fill=\"currentColor\"/>\n        <path d=\"M15.026,0.002C6.726,0.002,0,6.728,0,15.028c0,8.297,6.726,15.021,15.026,15.021c8.298,0,15.025-6.725,15.025-15.021   C30.052,6.728,23.324,0.002,15.026,0.002z M15.026,27.542c-6.912,0-12.516-5.601-12.516-12.514c0-6.91,5.604-12.518,12.516-12.518   c6.911,0,12.514,5.607,12.514,12.518C27.541,21.941,21.937,27.542,15.026,27.542z\" fill=\"currentColor\"/>\n    </g></svg>\n\n    <span>#{synology_nas_title}</span>\n    </div>";

    // нужна заглушка, а то при страте лампы говорит пусто

    Lampa.Component.add('synology_nas', component);
    Lampa.Component.add('dlna_browser', browser);

    // то же самое
    resetTemplates();

    /**
     * Пункт в главном меню: открыть корень DLNA-сервера
     */
    var menu_icon = "<svg viewBox=\"0 0 48 48\" xmlns=\"http://www.w3.org/2000/svg\"><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"5.5\" y=\"5.5\" width=\"37\" height=\"33.1724\" rx=\"1.252\"/><line x1=\"27.8276\" y1=\"5.5\" x2=\"27.8276\" y2=\"38.6724\"/><line x1=\"33.5898\" y1=\"12.2251\" x2=\"36.7378\" y2=\"12.2251\"/><line x1=\"33.5898\" y1=\"17.3047\" x2=\"36.7378\" y2=\"17.3047\"/><rect x=\"8.1292\" y=\"38.6724\" width=\"5.1034\" height=\"3.8276\"/><rect x=\"34.8687\" y=\"38.6724\" width=\"5.1034\" height=\"3.8276\"/></g></svg>";

    /**
     * Куда встать в меню. Первый список - навигация приложения ("Главная",
     * "Фильмы", "Сериалы"...), он наполняется динамически, поэтому цепляемся
     * за пункт "Главная", а не за номер позиции.
     */
    function placeMenuItem(item) {
    	var list = $('.menu .menu__list').eq(0);
    	var position = Lampa.Storage.get('dlna_menu_position', 'after_main');

    	if (position === 'top') return list.prepend(item);
    	if (position === 'bottom') return list.append(item);

    	var main = list.find('.menu__item[data-action="main"]');
    	if (main.length) main.after(item);else list.prepend(item);
    }

    function addMenuItem() {
    	if ($('.menu .menu__list .menu__item[data-action="dlna_browser"]').length) return;

    	var item = $('<li class="menu__item selector" data-action="dlna_browser">' + '<div class="menu__ico">' + menu_icon + '</div>' + '<div class="menu__text">' + Lampa.Lang.translate('dlna_browser_title') + '</div>' + '</li>');

    	item.on('hover:enter', function () {
    		resetTemplates();
    		Lampa.Component.add('dlna_browser', browser);
    		Lampa.Activity.push({
    			url: '',
    			title: Lampa.Lang.translate('dlna_browser_title'),
    			component: 'dlna_browser',
    			page: 1
    		});
    	});

    	placeMenuItem(item);
    }

    // смена настройки переставляет уже добавленный пункт, перезапуск не нужен
    if (Lampa.Storage.listener) Lampa.Storage.listener.follow('change', function (e) {
    	if (e.name === 'dlna_menu_position') placeMenuItem($('.menu .menu__item[data-action="dlna_browser"]'));
    });

    if (window.appready) addMenuItem();
    else {
    	Lampa.Listener.follow('app', function (e) {
    		if (e.type == 'ready') addMenuItem();
    	});
    }

    Lampa.Listener.follow('full', function (e) {
    	if (e.type == 'complite') {
    		var btn = $(Lampa.Lang.translate(button));
    		btn.on('hover:enter', function () {
    			resetTemplates();
    			Lampa.Component.add('synology_nas', component);
    			Lampa.Activity.push({
    				url: '',
    				title: Lampa.Lang.translate('synology_nas_title'),
    				component: 'synology_nas',
    				search: e.data.movie.title,
    				search_one: e.data.movie.title,
    				search_two: e.data.movie.original_title,
    				movie: e.data.movie,
    				page: 1
    			});
    		});
    		e.object.activity.render().find('.view--torrent').after(btn);
    	}
    });

    // настройки
    // https://github.com/yumata/lampa-source/blob/main/src/components/settings/api.js
    Lampa.SettingsApi.addComponent({
    	component: 'synology_nas_config',
    	name: 'DLNA (локальная сеть)',
    	icon: "<svg viewBox=\"0 0 48 48\" xmlns=\"http://www.w3.org/2000/svg\"><defs><style>.a{fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:3;}</style></defs><rect class=\"a\" x=\"5.5\" y=\"5.5\" width=\"37\" height=\"33.1724\" rx=\"1.252\"/><line class=\"a\" x1=\"27.8276\" y1=\"5.5\" x2=\"27.8276\" y2=\"38.6724\"/><line class=\"a\" x1=\"33.5898\" y1=\"12.2251\" x2=\"36.7378\" y2=\"12.2251\"/><line class=\"a\" x1=\"33.5898\" y1=\"17.3047\" x2=\"36.7378\" y2=\"17.3047\"/><rect class=\"a\" x=\"8.1292\" y=\"38.6724\" width=\"5.1034\" height=\"3.8276\"/><rect class=\"a\" x=\"34.8687\" y=\"38.6724\" width=\"5.1034\" height=\"3.8276\"/></svg>"
    });
    Lampa.SettingsApi.addParam({
    	component: 'synology_nas_config',
    	param: {
    		name: 'synology_nas_server',
    		type: 'input',
    		placeholder: '',
    		values: '',
    	default: ''
    	},
    	field: {
    		name: 'Адрес DLNA-сервера',
    		description: 'Например, 192.168.1.1:8200'
    	}
    });
    Lampa.SettingsApi.addParam({
    	component: 'synology_nas_config',
    	param: {
    		name: 'synology_nas_server_folder',
    		type: 'input', 
    		placeholder: '',
    		values: '',
    	default: ''
    	},
    	field: {
    		name: 'Папка с видео на DLNA-сервере',
    		description: 'Например, Video/All Video. Пусто = корень сервера'
    	}
    });    
    Lampa.SettingsApi.addParam({
    	component: 'synology_nas_config',
    	param: {
    		name: 'dlna_menu_position',
    		type: 'select',
    		values: {
    			top: 'В самом верху',
    			after_main: 'После «Главная»',
    			bottom: 'В конце списка'
    		},
    	default: 'after_main'
    	},
    	field: {
    		name: 'Пункт DLNA в меню',
    		description: 'Где показывать пункт в главном меню'
    	}
    });
    Lampa.SettingsApi.addParam({
    	component: 'synology_nas_config',
    	param: {
    		name: 'dlna_browser_root',
    		type: 'input',
    		placeholder: BROWSER_ROOT,
    		values: '',
    	default: BROWSER_ROOT
    	},
    	field: {
    		name: 'Стартовая папка страницы DLNA',
    		description: 'С какой ветки сервера собирать библиотеку. По умолчанию Video'
    	}
    });
    Lampa.SettingsApi.addParam({
    	component: 'synology_nas_config',
    	param: {
    		name: 'synology_nas_proxy',
        type: 'input', // доступно select,input,trigger,title,static
        placeholder: '',
        values: '',
      default: ''
      },
      field: {
      	name: 'Прокси',
      	description: 'Обычно не нужен. Например, 127.0.0.1:9118/proxy'
      }
    });         

  })();
