/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
'use strict';

const HTML = 'http://www.w3.org/1999/xhtml';
const XUL  = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';

const TYPE_TREE = 'application/x-ws-tree';
const TST_ID = 'treestyletab@piro.sakura.ne.jp';

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: 'resource://gre/modules/AddonManager.sys.mjs',
  CustomizableUI: 'resource:///modules/CustomizableUI.sys.mjs',
  ExtensionPermissions: 'resource://gre/modules/ExtensionPermissions.sys.mjs',
  PageThumbs: 'resource://gre/modules/PageThumbs.sys.mjs',
  PlacesUtils: 'resource://gre/modules/PlacesUtils.sys.mjs',
});

// Range.createContextualFragment() unexpectedly drops XUL elements.
// Moreover, the security mechanism of the browser rejects adoptation of elements
// created by DOMParser(). Thus we need to create elements manually...
function element(document, NS, localName, attributes, children) {
  if (Array.isArray(attributes)) {
    children   = attributes;
    attributes = {};
  }
  const element = document.createElementNS(NS, localName);
  if (attributes) {
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child == 'string')
        element.appendChild(document.createTextNode(child));
      else
        element.appendChild(child);
    }
  }
  return element;
}

const BrowserWindowWatcher = {
  WATCHING_URLS: [
    'chrome://browser/content/browser.xhtml',
    'chrome://browser/content/places/bookmarksSidebar.xhtml',
    'chrome://browser/content/places/places.xhtml',
  ],
  BASE_URL: null, // this need to be replaced with "moz-extension://..../"
  BASE_PREF: 'browser.sidebar.', // null,
  locale:   null, // this need to be replaced with a map
  loadingForbiddenURLs: [],
  autoplayBlockedListeners: new Set(),
  autoplayUnblockedListeners: new Set(),
  visibilityChangedListeners: new Set(),
  menuCommandListeners: new Set(),
  sidebarShownListeners: new Set(),
  sidebarHiddenListeners: new Set(),
  lastTransferredFiles: new Map(),

  handleWindow(win) {
    if (!win ||
        !win.location)
      return false;

    const document = win.document;
    if (!document)
      return false;

    if (win.location.href.startsWith('chrome://browser/content/browser.xhtml')) {
      const installed = this.installTabsSidebar(win);
      if (installed) {
        this.patchToTabHoverPreviewModules(win);
        this.patchToPlacesModules(win);
        win.addEventListener('DOMAudioPlaybackBlockStarted', this, { capture: true });
        win.addEventListener('DOMAudioPlaybackBlockStopped', this, { capture: true });
        win.addEventListener('visibilitychange', this);
        const sidebar = win.document?.querySelector('#sidebar');
        if (sidebar?.contentWindow?.PlacesControllerDragHelper) {
          this.patchToPlacesModules(sidebar.contentWindow);
        }
      }
      return installed;
    }
    else if (win.location.href.startsWith('chrome://browser/content/places/')) {
      const loaded = !!win.PlacesControllerDragHelper;
      if (loaded) {
        this.patchToPlacesModules(win);
      }
      return loaded;
    }

    return true;
  },

  unhandleWindow(win) {
    if (!win ||
        !win.location)
      return;

    const document = win.document;
    if (!document)
      return;

    if (win.location.href.startsWith('chrome://browser/content/browser.xhtml')) {
      this.uninstallTabsSidebar(win);
      try {
        this.unpatchTabHoverPreviewModules(win);
        this.unpatchPlacesModules(win);
        win.removeEventListener('DOMAudioPlaybackBlockStarted', this, { capture: true });
        win.removeEventListener('DOMAudioPlaybackBlockStopped', this, { capture: true });
        win.removeEventListener('visibilitychange', this);
        const sidebar = win.document?.querySelector('#sidebar');
        // Only unpatch if it seems to be a Places-related sidebar that would have been patched
        if (sidebar?.contentWindow?.PlacesControllerDragHelper) { // Or check a flag set during patching
          this.unpatchPlacesModules(sidebar.contentWindow);
        }
      }
      catch(_error) {
      }
    }
    else if (win.location.href.startsWith('chrome://browser/content/places/')) {
      try {
        this.unpatchPlacesModules(win);
      }
      catch(_error) {
      }
    }
  },

  installTabsSidebar(win) {
    const document = win.document;

    if (document.querySelector('#tabs-sidebar-style'))
      return true;

    const range = document.createRange();

    range.selectNode(document.head);
    range.collapse(false);
    range.insertNode(element(document, HTML, 'style', {
      id: 'tabs-sidebar-style',
    }, [`
      :root.hide-horizontal-tabs-while-tabs-sidebar-is-active.tabs-sidebar-is-active #TabsToolbar {
        visibility: collapse;
      }

      /* toolbar button */
      #toggle-tabs-sidebar {
        list-style-image: url("${this.BASE_URL}resources/16x16.svg#toolbar-context");
      }
      #toggle-tabs-sidebar image {
        -moz-context-properties: fill, fill-opacity;
        color: inherit;
        fill: currentColor;
        min-height: 16px;
        min-width: 16px;
      }

      /* tabs sidebar box */
      #tabs-sidebar-box {
        background-color: var(--sidebar-background-color);
        color: var(--sidebar-text-color);
        text-shadow: none;
        min-width: 50px;
      }
      :root[BookmarksToolbarOverlapsBrowser] #tabs-sidebar-box {
        padding-top: var(--bookmarks-toolbar-overlapping-browser-height);
      }

      #tabs-sidebar {
        flex: 1;
      }
    `.trim()]));

    // Note: keyboard shortcuts defined by XUL command/key become unavailable after
    // they are removed and re-insertedby reloading of this addon. For consistensy
    // it may need to be implemented without XUL elements...
    document.querySelector('#mainCommandSet').appendChild(element(document, XUL, 'command', {
      id: 'toggle-tabs-sidebar-command',
    }));
    // So, as a workaround we don't remove the key element on uninstallation and reuse existing key element.
    if (!document.querySelector('#toggle-tabs-sidebar-key')) {
      document.querySelector('#mainKeyset').appendChild(element(document, XUL, 'key', {
        id:      'toggle-tabs-sidebar-key',
        keycode: 'VK_F1',
        command: 'toggle-tabs-sidebar-command',
      }));
    }

    document.querySelector('#viewSidebarMenu').appendChild(element(document, XUL, 'menuseparator', {
      id: 'viewmenu-tabs-sidebar-separator',
    }));
    document.querySelector('#viewSidebarMenu').appendChild(element(document, XUL, 'menuitem', {
      id:    'viewmenu-toggle-tabs-sidebar',
      type:  'checkbox',
      label: this.locale.get('tabsSidebarButton_label'),
      key:   'toggle-tabs-sidebar-key',
    }));

    const elements = document.createDocumentFragment();

    const shouldShowSidebar = this.shouldShowSidebar(document);

    const width = Services.xulStore.getValue(document.URL, 'tabs-sidebar-box', 'width') || 200;

    const tabsSidebarElement = document.querySelector('#tabs-sidebar');
    if (tabsSidebarElement) {
      tabsSidebarElement.setAttribute('src', 'chrome://browser/content/webext-panels.xhtml');

      tabsSidebarElement.addEventListener('load', () => {
        // Ensure contentWindow is available before calling loadPanel
        const win = tabsSidebarElement.contentWindow;
        if (win) {
          win.document.querySelector('*|sidebar-panel-header').hidden = true;
          win.loadPanel(
            this.EXTENSION_ID,
            `${this.BASE_URL}sidebar/sidebar.html`,
            false
          );
        } else {
          console.error('WaterfoxBridge: #tabs-sidebar contentWindow is not available.');
        }
      }, { capture: true, once: true });

      tabsSidebarElement.addEventListener('dragover', event => {
        this.lastTransferredFiles.clear();
        for (const file of event.dataTransfer.files) {
          const fileInternal = Cc['@mozilla.org/file/local;1']
            .createInstance(Components.interfaces.nsIFile);
          fileInternal.initWithPath(file.mozFullPath);
          const url = Services.io.getProtocolHandler('file')
            .QueryInterface(Components.interfaces.nsIFileProtocolHandler)
            .getURLSpecFromActualFile(fileInternal);
          this.lastTransferredFiles[this.getKeyFromFile(file)] = url;
        }
      }, { capture: true });
    } else {
      console.error('WaterfoxBridge: #tabs-sidebar element not found. Cannot attach event listeners or load panel.');
    }

    document.addEventListener('SidebarShown', this, { capture: true });
    document.addEventListener('popupshowing', this);
    document.addEventListener('command', this);
    document.addEventListener('customizationchange', this, { capture: true });

    this.updateToggleButton(document);
    this.updateHorizontalTabsState(document);

    return true;
  },

  getKeyFromFile(file) {
    if (!file)
      return '';
    return `${file.name}?lastModified=${file.lastModified}&size=${file.size}&type=${file.type}`;
  },
  getFileURL(file) {
    if (!file)
      return '';
    return this.lastTransferredFiles[this.getKeyFromFile(file)];
  },

  sanitizeMenuLabel(label) {
    return label.replace(/\(&[a-z0-9]\)$/i, '').replace(/&([a-z0-9])/i, '$1');
  },

  extractAccessKey(label) {
    if (/\(&([a-z0-9])\)$/i.test(label) ||
        /&([a-z0-9])/i.test(label))
      return RegExp.$1;

    return null;
  },

  shouldShowSidebar(document) {
    // it should be hidden by default, as a built-in feature of Waterfox
    return Services.xulStore.getValue(document.URL, 'tabs-sidebar-box', 'hidden') != 'true';
  },

  uninstallTabsSidebar(win) {
    const document = win.document;

    document.documentElement.classList.remove('hide-horizontal-tabs-while-tabs-sidebar-is-active');
    document.documentElement.classList.remove('tabs-sidebar-is-active');
    win.CustomTitlebar.allowedBy('TabsSidebar', true);

    document.removeEventListener('SidebarShown', this, { capture: true });
    document.removeEventListener('popupshowing', this);
    document.removeEventListener('command', this);
    document.removeEventListener('customizationchange', this, { capture: true });

    const tabsSidebarElement = document.querySelector('#tabs-sidebar');
    if (tabsSidebarElement) {
      tabsSidebarElement.setAttribute('src', 'about:blank');
    }

    for (const node of document.querySelectorAll(`
      /* Don't remove key element because only the first element added is effective.*/
      /*#toggle-tabs-sidebar-key,*/
      #toggle-tabs-sidebar-command,
      #viewmenu-tabs-sidebar-separator,
      #viewmenu-toggle-tabs-sidebar,
      #tabs-sidebar-style
    `)) {
      node.parentNode.removeChild(node);
    }
  },

  patchToPlacesModules(win) {
    if (!win.PlacesControllerDragHelper.__ws_orig__getMostRelevantFlavor)
      win.PlacesControllerDragHelper.__ws_orig__getMostRelevantFlavor = win.PlacesControllerDragHelper.getMostRelevantFlavor;
    win.PlacesControllerDragHelper.getMostRelevantFlavor = function(flavours) {
      if (flavours.contains(TYPE_TREE))
        return TYPE_TREE;

      return this.__ws_orig__getMostRelevantFlavor(flavours);
    };

    if (!win.PlacesControllerDragHelper.__ws_orig__canDrop)
      win.PlacesControllerDragHelper.__ws_orig__canDrop = win.PlacesControllerDragHelper.canDrop;
    win.PlacesControllerDragHelper.canDrop = function(insertionPoint, dataTransfer) {
      if (dataTransfer.mozTypesAt(0).contains(TYPE_TREE))
        return true;

      return this.__ws_orig__canDrop(insertionPoint, dataTransfer);
    };
  },

  unpatchPlacesModules(win) {
    if (win.PlacesControllerDragHelper.__ws_orig__getMostRelevantFlavor) {
      win.PlacesControllerDragHelper.getMostRelevantFlavor = win.PlacesControllerDragHelper.__ws_orig__getMostRelevantFlavor;
      win.PlacesControllerDragHelper.__ws_orig__getMostRelevantFlavor = null;
    }

    if (win.PlacesControllerDragHelper.__ws_orig__canDrop) {
      win.PlacesControllerDragHelper.canDrop = win.PlacesControllerDragHelper.__ws_orig__canDrop;
      win.PlacesControllerDragHelper.__ws_orig__canDrop = null;
    }
  },

  patchToTabHoverPreviewModules(win) {
    const tabs = win.document.getElementById('tabbrowser-tabs');
    if (!tabs)
      return;

    if (!tabs._previewPanel) {
      // https://searchfox.org/mozilla-esr128/rev/7998c47697fb3ba3e380eda1281c8280da81a0b1/browser/components/tabbrowser/content/tabs.js#187
      const TabHoverPreviewPanel = ChromeUtils.importESModule('chrome://browser/content/tabbrowser/tab-hover-preview.mjs').default;
      tabs._previewPanel = new TabHoverPreviewPanel(win.document.getElementById('tab-preview-panel'));
    }

    const tabPreview = tabs._previewPanel;
    if (!tabPreview ||
        !tabPreview.activate)
      return;

    tabPreview.__ws__calculateCoordinates = () => {
      const tabsSidebar = win.document.querySelector('#tabs-sidebar');
      const tabsSidebarRect = tabsSidebar.getBoundingClientRect();
      const align = win.document.documentElement.classList.contains('tabs-sidebar-right') ? 'right' : 'left';
      const previewRect = tabPreview._panel.getBoundingClientRect();
      const x = align == 'left' ?
        tabsSidebar.screenX + tabsSidebarRect.width - 2 :
        tabsSidebar.screenX - previewRect.width + 2;
      const y = Math.min(tabsSidebar.screenY + tabPreview.__ws__top, tabsSidebar.screenY + tabsSidebarRect.height - previewRect.height);
      return [x, y];
    };

    if (!tabPreview.__ws_orig__activate)
      tabPreview.__ws_orig__activate = tabPreview.activate;
    // https://searchfox.org/mozilla-esr128/rev/7998c47697fb3ba3e380eda1281c8280da81a0b1/browser/components/tabbrowser/content/tab-hover-preview.mjs#97
    const self = this;
    tabPreview.activate = function(tab) {
      if (this._isDisabled()) {
        return;
      }
      this._tab = tab;
      this._movePanel();

      this._thumbnailElement = null;
      this._maybeRequestThumbnail();
      if (this._panel.state == 'open') {
        this._updatePreview();
      }
      if (this._timer) {
        return;
      }
      this._timer = this._win.setTimeout(() => {
        this._timer = null;
        if (self.shouldShowSidebar(win.document) &&
            typeof this.__ws__top == 'number') {
          const [x, y] = tabPreview.__ws__calculateCoordinates();
          this._panel.openPopupAtScreen(x, y, false);
        }
        else {
          this._panel.openPopup(this._tab, {
            // POPUP_OPTIONS https://searchfox.org/mozilla-esr128/rev/7998c47697fb3ba3e380eda1281c8280da81a0b1/browser/components/tabbrowser/content/tab-hover-preview.mjs#9
            position: 'bottomleft topleft',
            x: 0,
            y: -2,
          });
        }
      }, this._prefPreviewDelay);
      this._win.addEventListener('TabSelect', this);
      this._panel.addEventListener('popupshowing', this);
    };

    if (!tabPreview._panel.__ws_orig__moveToAnchor)
      tabPreview._panel.__ws_orig__moveToAnchor = tabPreview._panel.moveToAnchor;
    tabPreview._panel.moveToAnchor = function(...args) {
      if (self.shouldShowSidebar(win.document) &&
          typeof tabPreview.__ws__top == 'number') {
        const [x, y] = tabPreview.__ws__calculateCoordinates();
        this.moveTo(x, y);
        return;
      }
      return this.__ws_orig__moveToAnchor(...args);
    };
  },

  unpatchTabHoverPreviewModules(win) {
    const tabPreview = win.document.getElementById('tabbrowser-tabs')?._previewPanel;
    if (!tabPreview ||
        !tabPreview.activate)
      return;

    if (tabPreview.__ws_orig__activate) {
      tabPreview.activate = tabPreview.__ws_orig__activate;
      tabPreview.__ws_orig__activate = null;
    }

    if (tabPreview._panel?.__ws_orig__moveToAnchor) {
      tabPreview._panel.moveToAnchor = tabPreview._panel.__ws_orig__moveToAnchor;
      tabPreview._panel.__ws_orig__moveToAnchor = null;
    }
  },

  updateToggleButton(document, button) {
    button = button || document.querySelector('#toggle-tabs-sidebar');
    if (!button)
      return;

    const viewMenuItem = document.querySelector('#viewmenu-toggle-tabs-sidebar');
    if (this.shouldShowSidebar(document)) {
      button.setAttribute('checked', true);
      button.setAttribute('tooltiptext', this.locale.get('closeButton_tooltip'));
      viewMenuItem.setAttribute('checked', true);
    }
    else {
      button.removeAttribute('checked');
      button.setAttribute('tooltiptext', this.locale.get('openButton_tooltip'));
      viewMenuItem.removeAttribute('checked');
    }
  },

  *iteratePlacesOwnerWindows() {
    const browserWindows = Services.wm.getEnumerator('navigator:browser');
    while (browserWindows.hasMoreElements()) {
      const win = browserWindows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/
      yield win;
      const sidebar = win.document?.querySelector('#sidebar');
      if (sidebar)
        yield sidebar.contentWindow;
    }

    const organizerWindows = Services.wm.getEnumerator('Places:Organizer');
    while (organizerWindows.hasMoreElements()) {
      const win = organizerWindows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/
      yield win;
    }

    return;
  },

  openOptions(win, full = false) {
    const url = full ? `${this.BASE_URL}options/options.html#!` : 'about:preferences#tabsSidebar';

    const windows = Services.wm.getEnumerator('navigator:browser');
    while (windows.hasMoreElements()) {
      const win = windows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/;
      if (!win.gBrowser)
        continue;
      for (const tab of win.gBrowser.tabs) {
        if (tab.linkedBrowser.currentURI.spec != url)
          continue;
        win.gBrowser.selectedTab = tab;
        return;
      }
    }

    (win || Services.wm.getMostRecentBrowserWindow())
      .openLinkIn(url, 'tab', {
        allowThirdPartyFixup: false,
        triggeringPrincipal:  Services.scriptSecurityManager.getSystemPrincipal(),
        inBackground:         false,
      });
  },

  toggleTabsToolbar(document) {
    const shouldOpen = document.querySelector('#tabs-sidebar-box').getAttribute('hidden') == 'true';
    if (shouldOpen)
      this.openTabsSidebar(document);
    else
      this.closeTabsSidebar(document);
    this.updateToggleButton(document);
    this.updateHorizontalTabsState(document);
  },

  updateHorizontalTabsState(document) {
    const sidebarBox = document.querySelector('#tabs-sidebar-box');
    let active = false;
    if (sidebarBox) {
      active = sidebarBox.getAttribute('hidden') != 'true';
    } else {
      console.error('WaterfoxBridge: #tabs-sidebar-box element not found in window:', document.defaultView.location.href, '. Cannot update horizontal tabs state.');
      // Defaulting to 'active = false' as a fallback
    }
    const hideHorizontalTabsWhileActive = Services.prefs.getBoolPref(`${this.BASE_PREF}hideHorizontalTabsWhileActive`, true);

    document.documentElement.classList.toggle('tabs-sidebar-is-active', active);
    document.documentElement.classList.toggle('hide-horizontal-tabs-while-tabs-sidebar-is-active', hideHorizontalTabsWhileActive);
    if (document.defaultView.CustomTitlebar &&
        typeof document.defaultView.CustomTitlebar.allowedBy === 'function') {
      document.defaultView.CustomTitlebar.allowedBy('TabsSidebar', !hideHorizontalTabsWhileActive || !active);
    } else {
      console.warn('WaterfoxBridge: CustomTitlebar or CustomTitlebar.allowedBy is not available on window:', document.defaultView.location.href);
    }
  },

  openTabsSidebar(document) {
    const box = document.querySelector('#tabs-sidebar-box');
    box.removeAttribute('hidden');
    Services.xulStore.removeValue(document.URL, box.id, 'hidden');

    const nativeVerticalTabs = document.querySelector('#vertical-tabs');
    nativeVerticalTabs.setAttribute('hidden', true);
    nativeVerticalTabs.removeAttribute('visible');

    for (const listener of this.sidebarShownListeners) {
      listener(document.defaultView);
    }
  },

  closeTabsSidebar(document) {
    const box = document.querySelector('#tabs-sidebar-box');
    box.setAttribute('hidden', true);
    Services.xulStore.persist(box, 'hidden');

    const nativeVerticalTabs = document.querySelector('#vertical-tabs');
    nativeVerticalTabs.removeAttribute('hidden');
    nativeVerticalTabs.setAttribute('visible', '');

    for (const listener of this.sidebarHiddenListeners) {
      listener(document.defaultView);
    }
  },

  handleEvent(event) {
    const win = event.target.ownerDocument?.defaultView || event.target.defaultView;
    switch (event.type) {
      case 'command':
        switch (event.target.id) {
          case 'toggle-tabs-sidebar':
          case 'toggle-tabs-sidebar-command':
          case 'viewmenu-toggle-tabs-sidebar':
            this.toggleTabsToolbar(event.target.ownerDocument);
            break;

          case 'tabs-sidebar-moreOptions':
            this.openOptions(win, event.shiftKey);
            this.tryHidePopup(event);
            break;
        }
        break;

      case 'mouseup':
        Services.xulStore.persist(event.target.ownerDocument.querySelector('#tabs-sidebar-box'), 'width');
        break;

      case 'customizationchange':
        this.updateToggleButton(event.target.ownerDocument);
        break;

      case 'DOMAudioPlaybackBlockStarted': {
        const gBrowser = event.target.ownerDocument.defaultView.gBrowser;
        const tab      = gBrowser.getTabForBrowser(event.target);
        for (const listener of this.autoplayBlockedListeners) {
          listener(tab);
        }
      }; break;

      case 'DOMAudioPlaybackBlockStopped': {
        const gBrowser = event.target.ownerDocument.defaultView.gBrowser;
        const tab      = gBrowser.getTabForBrowser(event.target);
        for (const listener of this.autoplayUnblockedListeners) {
          listener(tab);
        }
      }; break;

      case 'visibilitychange':
        for (const listener of this.visibilityChangedListeners) {
          listener(event.currentTarget);
        }
        break;
    }
  },
  tryHidePopup(event) {
    if (event.target.closest)
      event.target.closest('panel')?.hidePopup();
  },

  moveToolbarButtonToDefaultPosition() {
    try {
      const rawState = Services.prefs.getStringPref('browser.uiCustomization.state', '{}');
      if (!rawState)
        return false;

      const state = JSON.parse(rawState);
      if (!state?.placements)
        return false;

      let foundInNavBar = false;
      let found = false;
      for (const [name, items] of Object.entries(state.placements)) {
        if (!items.includes(this.id))
          continue;
        if (name == 'nav-bar')
          foundInNavBar = true;
        found = true;
        break;
      }

      const navBarItems = state.placements['nav-bar'];
      const searchIndex = navBarItems.indexOf('search-container');
      const urlbarIndex = navBarItems.indexOf('urlbar-container');
      const extensionsIndex = navBarItems.indexOf('unified-extensions-button');
      const index = searchIndex > -1 ? searchIndex + 1 :
        urlbarIndex > -1 ? urlbarIndex + 1 :
          extensionsIndex > -1 ? extensionsIndex :
            navBarItems.length;

      if (foundInNavBar)
        lazy.CustomizableUI.moveWidgetWithinArea(this.id, index);
      else if (!found)
        lazy.CustomizableUI.addWidgetToArea(this.id, this.defaultArea, index);

      const win = Services.wm.getMostRecentBrowserWindow();
      win.setTimeout(() => {
        if (win.document.getElementById(this.id))
          return;
        console.log('failed to insert tabs sidebar button due to unhandled error in CustomizableUI module: retrying with reset');
        win.gCustomizeMode.reset();
      }, 250); // for safety, this delay need to be large enough

      return true;
    }
    catch (error) {
      console.log('failed to insert tabs sidebar button: ', error);
    }
    return false;
  },

  // behave as a toolbar customization widget
  id: 'toggle-tabs-sidebar',
  type: 'custom',
  source: 'external',
  removable: true,
  get label() {
    return this.locale.get('tabsSidebarButton_label');
  },
  get tooltiptext() {
    return this.locale.get('tabsSidebarButton_tooltiptext');
  },
  defaultArea: lazy.CustomizableUI.AREA_NAVBAR,
  showInPrivateBrowsing: true,
  disallowSubView: false,
  localized: false,
  shortcutId: 'toggle-tabs-sidebar-key',
  onBuild(document) {
    const node = element(document, XUL, 'toolbarbutton', {
      id:          'toggle-tabs-sidebar',
      class:       'toolbarbutton-1',
      type:        'checkbox',
      label:       this.locale.get('tabsSidebarButton_label'),
    }, [
      element(document, XUL, 'image', {
        class: 'toolbarbutton-icon',
      }),
      element(document, XUL, 'label', {
        class: 'toolbarbutton-text',
        crop:  'end',
        flex:  '1',
      }, [this.locale.get('tabsSidebarButton_label')]),
    ]);
    this.updateToggleButton(document, node);
    return node;
  },
  onCreated(node) {
    this.updateToggleButton(node.ownerDocument, node);
  },

  onPrefChanged(name) {
    switch (name) {
      case `${this.BASE_PREF}hideHorizontalTabsWhileActive`: {
        const windows = Services.wm.getEnumerator('navigator:browser');
        while (windows.hasMoreElements()) {
          const win = windows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/;
          this.updateHorizontalTabsState(win.document);
        }
      }; break;

      case 'browser.uiCustomization.state': {
        if (!Services.prefs.getStringPref(name)) { // resetting!
          const tryInsertButton = () => {
            if (!Services.prefs.getStringPref(name)) {
              Services.wm.getMostRecentBrowserWindow().setTimeout(tryInsertButton, 10);
              return;
            }
            this.moveToolbarButtonToDefaultPosition();
          };
          tryInsertButton();
        }
      }; break;
    }
  },

  // as an XPCOM component...
  classDescription: 'Waterfox Chrome Window Watcher for Browser Windows',
  contractID:       '@waterfox.net/chrome-window-watche-browser-windows;1',
  classID:          Components.ID('{8d25e5cc-1d67-4556-819e-e25bd37c79c5}'),
  QueryInterface:   ChromeUtils.generateQI([
    'nsIContentPolicy',
    'nsIObserver',
    'nsISupportsWeakReference',
  ]),

  // nsIContentPolicy
  shouldLoad(contentLocation, loadInfo, mimeTypeGuess) {
     const FORBIDDEN_URL_MATCHER = /^about:blank\?forbidden-url=/;
     if (FORBIDDEN_URL_MATCHER.test(contentLocation.spec)) {
       const url = contentLocation.spec.replace(FORBIDDEN_URL_MATCHER, '');
       const index = this.loadingForbiddenURLs.indexOf(url);
       if (index > -1) {
         this.loadingForbiddenURLs.splice(index, 1);
         const browser = loadInfo.browsingContext.embedderElement;
         browser.loadURI(Services.io.newURI(url), {
           triggeringPrincipal:  Services.scriptSecurityManager.getSystemPrincipal(),
         });
         return Components.interfaces.nsIContentPolicy.REJECT_REQUEST;
       }
     }

    if (this.WATCHING_URLS.some(url => contentLocation.spec.startsWith(url))) {
      const startAt = Date.now();
      const topWin  = loadInfo.browsingContext.topChromeWindow;
      const timer   = topWin.setInterval(() => {
        if (Date.now() - startAt > 1000) {
          // timeout
          topWin.clearInterval(timer);
          return;
        }
        const win = loadInfo.browsingContext.window;
        if (!win)
          return;
        try {
          if (this.handleWindow(win))
            topWin.clearInterval(timer);
        }
        catch(_error) {
        }
      }, 250);
    }
    return Components.interfaces.nsIContentPolicy.ACCEPT;
  },

  shouldProcess(contentLocation, loadInfo, mimeTypeGuess) {
    return Components.interfaces.nsIContentPolicy.ACCEPT;
  },

  // nsIObserver
  observe(subject, topic, data) {
    switch (topic) {
      case 'domwindowopened':
        subject
          //.QueryInterface(Components.interfaces.nsIDOMWindow)
          .addEventListener('DOMContentLoaded', () => {
            this.handleWindow(subject);
          }, { once: true });
        break;

      case 'nsPref:changed':
        this.onPrefChanged(data);
        break;
    }
  },

  createInstance(iid) {
    return this.QueryInterface(iid);
  },


  // AddonManager listener callbacks

  async tryConfirmUsingTST() {
    const ignorePrefKey = `${this.BASE_PREF}.ignoreConflictionWithTST`;
    if (Services.prefs.getBoolPref(ignorePrefKey, false))
      return;

    const nsIPrompt = Components.interfaces.nsIPrompt;
    const shouldAsk = { value: true };
    const result = Services.prompt.confirmEx(
      Services.wm.getMostRecentBrowserWindow(),
      this.locale.get('tryConfirmUsingTST_title'),
      this.locale.get('tryConfirmUsingTST_message'),
      (nsIPrompt.BUTTON_TITLE_IS_STRING * nsIPrompt.BUTTON_POS_0 |
       nsIPrompt.BUTTON_TITLE_IS_STRING * nsIPrompt.BUTTON_POS_1 |
       nsIPrompt.BUTTON_TITLE_IS_STRING * nsIPrompt.BUTTON_POS_2),
      this.locale.get('tryConfirmUsingTST_WS'),
      this.locale.get('tryConfirmUsingTST_both'),
      this.locale.get('tryConfirmUsingTST_TST'),
      this.locale.get('tryConfirmUsingTST_ask'),
      shouldAsk
    );

    if (result > -1 &&
        !shouldAsk.value)
      Services.prefs.setBoolPref(ignorePrefKey, true);

    switch (result) {
      case 0: {
        const addon = await lazy.AddonManager.getAddonByID(TST_ID);
        addon.disable();
      }; return;

      case 2: {
        Services.prompt.alert(
          Services.wm.getMostRecentBrowserWindow(),
          this.locale.get('howToActivateAgain_title'),
          this.locale.get('howToActivateAgain_message')
        );
        const addon = await lazy.AddonManager.getAddonByID(this.EXTENSION_ID);
        addon.disable();
      }; return;

      default:
        return;
    }
  },

  // install listener callbacks
  onNewInstall(_install) {},
  onInstallCancelled(_install) {},
  onInstallPostponed(_install) {},
  onInstallFailed(_install) {},
  onInstallEnded(install) {
    if (install.addon.id == TST_ID)
      this.tryConfirmUsingTST();
  },
  onDownloadStarted(_install) {},
  onDownloadCancelled(_install) {},
  onDownloadEnded(_install) {},
  onDownloadFailed(_install) {},

  // addon listener callbacks
  onUninstalled(_addon) {},
  onEnabled(addon) {
    if (addon.id == TST_ID)
      this.tryConfirmUsingTST();
  },
  onDisabled(_addon) {},
};

this.waterfoxBridge = class extends ExtensionAPI {
  getAPI(context) {
    const EventManager = ExtensionCommon.EventManager;

    return {
      waterfoxBridge: {
        async initUI() {
          BrowserWindowWatcher.EXTENSION_ID = context.extension.id;
          BrowserWindowWatcher.BASE_URL = context.extension.baseURL;
          //BrowserWindowWatcher.BASE_PREF = `extensions.${context.extension.id.split('@')[0]}.`;
          BrowserWindowWatcher.locale   = {
            get(key) {
              key = key.toLowerCase();
              if (this.selected.has(key))
                return this.selected.get(key);
              return this.default.get(key) || key;
            },
            default:  context.extension.localeData.messages.get(context.extension.localeData.defaultLocale),
            selected: context.extension.localeData.messages.get(context.extension.localeData.selectedLocale),
          };
          Services.prefs.addObserver('', BrowserWindowWatcher);

          //const resourceURI = Services.io.newURI('resources', null, context.extension.rootURI);
          //const handler = Cc['@mozilla.org/network/protocol;1?name=resource'].getService(Components.interfaces.nsISubstitutingProtocolHandler);
          //handler.setSubstitution('waterfox-bridge', resourceURI);

          // watch loading of about:preferences in subframes
          const registrar = Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);
          registrar.registerFactory(
            BrowserWindowWatcher.classID,
            BrowserWindowWatcher.classDescription,
            BrowserWindowWatcher.contractID,
            BrowserWindowWatcher
          );
          Services.catMan.addCategoryEntry(
            'content-policy',
            BrowserWindowWatcher.contractID,
            BrowserWindowWatcher.contractID,
            false,
            true
          );

          // handle loading of browser windows
          Services.ww.registerNotification(BrowserWindowWatcher);

          // handle already opened browser windows
          const windows = BrowserWindowWatcher.iteratePlacesOwnerWindows();
          while (true) {
            const win = windows.next();
            if (win.done)
              break;
            BrowserWindowWatcher.handleWindow(win.value);
          }

          // add toolbar button
          lazy.CustomizableUI.createWidget(BrowserWindowWatcher);
          if (!Services.prefs.getBoolPref(`${BrowserWindowWatcher.BASE_PREF}toolbarButtonInserted`, false) &&
              BrowserWindowWatcher.moveToolbarButtonToDefaultPosition())
            Services.prefs.setBoolPref(`${BrowserWindowWatcher.BASE_PREF}toolbarButtonInserted`, true);

          // support drag and drop of tabs from sidebar to bookmarks toolbar
          if (!lazy.PlacesUtils.__ws_orig__unwrapNodes)
            lazy.PlacesUtils.__ws_orig__unwrapNodes = lazy.PlacesUtils.unwrapNodes;
          lazy.PlacesUtils.unwrapNodes = function(blob, type) {
            if (type == TYPE_TREE) {
              const nodes = [];
              const data = JSON.parse(blob);
              for (const tab of data.tabs) {
                nodes.push({
                  uri:   tab.url,
                  title: tab.title,
                  type:  'text/x-moz-url',
                });
              }
              return nodes;
            }
            return this.__ws_orig__unwrapNodes(blob, type);
          };

          // grant special permissions by default
          if (!Services.prefs.getBoolPref(`${BrowserWindowWatcher.BASE_PREF}permissionsGranted`, false)) {
            lazy.ExtensionPermissions.add(context.extension.id, {
              origins: ['<all_urls>'],
              permissions: ['internal:privateBrowsingAllowed'],
            }, true);
            Services.prefs.setBoolPref(`${BrowserWindowWatcher.BASE_PREF}permissionsGranted`, true);
          }

          // auto detection and warning for TST
          lazy.AddonManager.addInstallListener(BrowserWindowWatcher);
          lazy.AddonManager.addAddonListener(BrowserWindowWatcher);
          const installedTST = await lazy.AddonManager.getAddonByID(TST_ID);
          if (installedTST?.isActive)
            BrowserWindowWatcher.tryConfirmUsingTST();
        },

        async reserveToLoadForbiddenURL(url) {
          BrowserWindowWatcher.loadingForbiddenURLs.push(url);
        },

        async getFileURL(file) {
          return BrowserWindowWatcher.getFileURL(file);
        },

        async getTabPreview(tabId) {
          const info = {
            url:   null,
            found: false,
          };
          const tab = context.extension.tabManager.get(tabId);
          if (!tab)
            return info;

          const nativeTab = tab.nativeTab;
          const window    = nativeTab.ownerDocument.defaultView;
          try {
            const canvas = await window.tabPreviews.get(nativeTab);
            /*
            // We can get a URL like "https%3A%2F%2Fwww.example.com.org%2F&revision=0000"
            // but Firefox does not allow loading of such a special internal URL from
            // addon's sidebar page.
            const image     = await window.tabPreviews.get(nativeTab);
            return image.src;
            */
            if (canvas) {
              info.url   = canvas.toDataURL('image/png');
              info.found = true;
              return info;
            }
          }
          catch (_error) { // tabPreviews.capture() raises error if the tab is discarded.
            // console.error('waterfoxBridge: failed to take a tab preview: ', tabId, error);
          }

          // simulate default preview
          // see also: https://searchfox.org/mozilla-esr115/rev/d0623081f317c92e0c7bc2a8b1b138687bdb23f5/browser/themes/shared/ctrlTab.css#85-94
          const canvas = lazy.PageThumbs.createCanvas(window);
          try {
            // TODO: we should change the fill color to "CanvasText"...
            const image = new window.Image();
            await new Promise((resolve, reject) => {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', reject, { once: true });
              image.src = 'chrome://global/skin/icons/defaultFavicon.svg';
            });
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'Canvas';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const iconSize = canvas.width * 0.2;
            ctx.drawImage(
              image,
              0,
              0,
              image.width,
              image.height,
              (canvas.width - iconSize) / 2,
              (canvas.height - iconSize) / 2,
              iconSize,
              iconSize
            );
          }
          catch (_error) {
          }
          info.url = canvas.toDataURL('image/png');
          return info;
        },

        async showPreviewPanel(tabId, top) {
          const tab = tabId && context.extension.tabManager.get(tabId);
          if (!tab)
            return;

          const document = tab.nativeTab.ownerDocument;
          const tabPreview = document.getElementById('tabbrowser-tabs')?._previewPanel;
          if (!tabPreview)
            return;
          tabPreview.__ws__top = top;
          tabPreview.activate(tab.nativeTab);
        },

        async hidePreviewPanel(windowId) {
          const win = windowId && context.extension.windowManager.get(windowId);
          if (!win || !win.window)
            return;

          try {
            // Access the document through the window object
            const document = win.window.document;
            const tabPreview = document.getElementById('tabbrowser-tabs')?._previewPanel;
            if (!tabPreview)
              return;
            tabPreview.__ws__top = null;
          } catch (error) {
            console.log("Error in hidePreviewPanel:", error);
          }
        },

        async openPreferences() {
          BrowserWindowWatcher.openOptions();
        },

        onWindowVisibilityChanged: new EventManager({
          context,
          name: 'waterfoxBridge.onWindowVisibilityChanged',
          register: (fire) => {
            const onChanged = win => {
              const wrappedWindow = context.extension.windowManager.getWrapper(win);
              if (wrappedWindow)
                fire.async(wrappedWindow.id, win.document.visibilityState).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.visibilityChangedListeners.add(onChanged);
            return () => {
              BrowserWindowWatcher.visibilityChangedListeners.delete(onChanged);
            };
          },
        }).api(),

        onMenuCommand: new EventManager({
          context,
          name: 'waterfoxBridge.onMenuCommand',
          register: (fire) => {
            const onCommand = event => {
              fire.async({
                itemId:   event.target.id,
                detail:   event.detail,
                button:   event.button,
                altKey:   event.altKey,
                ctrlKey:  event.ctrlKey,
                metaKey:  event.metaKey,
                shiftKey: event.shiftKey,
              }).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.menuCommandListeners.add(onCommand);
            return () => {
              BrowserWindowWatcher.menuCommandListeners.delete(onCommand);
            };
          },
        }).api(),

        onSidebarShown: new EventManager({
          context,
          name: 'waterfoxBridge.onSidebarShown',
          register: (fire) => {
            const onShown = win => {
              const wrappedWindow = context.extension.windowManager.getWrapper(win);
              if (wrappedWindow)
                fire.async(wrappedWindow.id).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.sidebarShownListeners.add(onShown);
            return () => {
              BrowserWindowWatcher.sidebarShownListeners.delete(onShown);
            };
          },
        }).api(),

        onSidebarHidden: new EventManager({
          context,
          name: 'waterfoxBridge.onSidebarHidden',
          register: (fire) => {
            const onHidden = win => {
              const wrappedWindow = context.extension.windowManager.getWrapper(win);
              if (wrappedWindow)
                fire.async(wrappedWindow.id).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.sidebarHiddenListeners.add(onHidden);
            return () => {
              BrowserWindowWatcher.sidebarHiddenListeners.delete(onHidden);
            };
          },
        }).api(),


        async listSyncDevices() {
          const devices = [];
          const targets = Services.wm.getMostRecentBrowserWindow().gSync.getSendTabTargets();
          for (const target of targets) {
            devices.push({
              id:   target.id,
              name: target.name,
              type: target.type,
            });
          }
          return devices;
        },

        async sendToDevice(tabIds, deviceId) {
          if (!Array.isArray(tabIds))
            tabIds = [tabIds];
          const gSync = Services.wm.getMostRecentBrowserWindow().gSync;
          const tabs = tabIds.map(id => context.extension.tabManager.get(id));
          const targets = gSync.getSendTabTargets().filter(target => !deviceId || target.id == deviceId);
          for (const tab of tabs) {
            gSync.sendTabToDevice(
              tab.nativeTab.linkedBrowser.currentURI.spec,
              targets,
              tab.nativeTab.linkedBrowser.contentTitle
            );
          }
        },

        async openSyncDeviceSettings(windowId) {
          let DOMWin = null;
          try {
            const win = windowId && context.extension.windowManager.get(windowId)
            DOMWin = win?.window;
          }
          catch (_error) {
          }
          (DOMWin || Services.wm.getMostRecentBrowserWindow()).gSync.openDevicesManagementPage('sendtab');
        },


        async listSharingServices(tabId) {
          const tab = tabId && context.extension.tabManager.get(tabId);

          const services = [];
          const win = Services.wm.getMostRecentBrowserWindow();
          const sharingService = win.gBrowser.MacSharingService;
          if (!sharingService)
            return services;

          const uri = win.gURLBar.makeURIReadable(
            tab?.nativeTab.linkedBrowser.currentURI ||
            Services.io.newURI('https://waterfox.net/', null, null)
          ).displaySpec;
          for (const service of sharingService.getSharingProviders(uri)) {
            services.push({
              name:  service.name,
              title: service.menuItemTitle,
              image: service.image,
            });
          }
          return services;
        },

        async share(tabIds, shareName) {
          if (!Array.isArray(tabIds))
            tabIds = [tabIds];
          const tabs = tabIds.map(id => context.extension.tabManager.get(id));

          // currently we can share only one URL at a time...
          const tab = tabs[0];
          const win = Services.wm.getMostRecentBrowserWindow();
          const uri = win.gURLBar.makeURIReadable(tab.nativeTab.linkedBrowser.currentURI).displaySpec;

          if (AppConstants.platform == 'win') {
            win.WindowsUIUtils.shareUrl(uri, tab.nativeTab.linkedBrowser.contentTitle);
            return;
          }

          if (shareName) { // for macOS
            win.gBrowser.MacSharingService.shareUrl(shareName, uri, tab.nativeTab.linkedBrowser.contentTitle);
            return;
          }
        },

        async openSharingPreferences() {
          Services.wm.getMostRecentBrowserWindow().gBrowser.MacSharingService.openSharingPreferences();
        },


        async listAutoplayBlockedTabs(windowId) {
          const tabs = new Set();
          const windows = windowId ?
            [context.extension.windowManager.get(windowId)] :
            context.extension.windowManager.getAll();
          for (const win of windows) {
            if (!win.window.gBrowser)
              continue;
            for (const tab of win.window.document.querySelectorAll('tab[activemedia-blocked="true"]')) {
              const wrappedTab = context.extension.tabManager.getWrapper(tab);
              if (wrappedTab)
                tabs.add(wrappedTab.convert());
            }
          }
          return [...tabs].sort((a, b) => a.index - b.index);
        },

        async isAutoplayBlockedTab(tabId) {
          const tab = context.extension.tabManager.get(tabId);
          if (!tab)
            return false;
          return tab.nativeTab.getAttribute('activemedia-blocked') == 'true';
        },

        async unblockAutoplay(tabIds) {
          if (!Array.isArray(tabIds))
            tabIds = [tabIds];
          const tabs = tabIds.map(id => context.extension.tabManager.get(id));
          for (const tab of tabs) {
            tab.nativeTab.linkedBrowser.resumeMedia();
          }
        },

        onAutoplayBlocked: new EventManager({
          context,
          name: 'waterfoxBridge.onAutoplayBlocked',
          register: (fire) => {
            const onBlocked = tab => {
              const wrappedTab = context.extension.tabManager.getWrapper(tab);
              if (wrappedTab)
                fire.async(wrappedTab.convert()).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.autoplayBlockedListeners.add(onBlocked);
            return () => {
              BrowserWindowWatcher.autoplayBlockedListeners.delete(onBlocked);
            };
          },
        }).api(),

        onAutoplayUnblocked: new EventManager({
          context,
          name: 'waterfoxBridge.onAutoplayUnblocked',
          register: (fire) => {
            const onUnblocked = tab => {
              const wrappedTab = context.extension.tabManager.getWrapper(tab);
              if (wrappedTab)
                fire.async(wrappedTab.convert()).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.autoplayUnblockedListeners.add(onUnblocked);
            return () => {
              BrowserWindowWatcher.autoplayUnblockedListeners.delete(onUnblocked);
            };
          },
        }).api(),


        async isSelectionClipboardAvailable() {
          try {
            return Services.clipboard.isClipboardTypeSupported(Services.clipboard.kSelectionClipboard);
          }
          catch(_error) {
            return false;
          }
        },

        async getSelectionClipboardContents() {
          try {
            const transferable = Components.classes['@mozilla.org/widget/transferable;1']
              .createInstance(Components.interfaces.nsITransferable);
            const loadContext = Services.wm.getMostRecentBrowserWindow()
              .docShell.QueryInterface(Components.interfaces.nsILoadContext);
            transferable.init(loadContext);
            transferable.addDataFlavor('text/plain');

            Services.clipboard.getData(transferable, Services.clipboard.kSelectionClipboard);

            const data = {};
            transferable.getTransferData('text/plain', data);
            if (data) {
              data = data.value.QueryInterface(Components.interfaces.nsISupportsString);
              return data.data;
            }
          }
          catch(_error) {
            return '';
          }
        },
      },
    };
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown)
      return;

    lazy.AddonManager.removeInstallListener(BrowserWindowWatcher);
    lazy.AddonManager.removeAddonListener(BrowserWindowWatcher);

    if (lazy.PlacesUtils.__ws_orig__unwrapNodes) {
      lazy.PlacesUtils.unwrapNodes = lazy.PlacesUtils.__ws_orig__unwrapNodes;
      lazy.PlacesUtils.__ws_orig__unwrapNodes = null;
    }

    lazy.CustomizableUI.destroyWidget(BrowserWindowWatcher.id);

    const registrar = Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);
    registrar.unregisterFactory(
      BrowserWindowWatcher.classID,
      BrowserWindowWatcher
    );
    Services.catMan.deleteCategoryEntry(
      'content-policy',
      BrowserWindowWatcher.contractID,
      false
    );

    Services.ww.unregisterNotification(BrowserWindowWatcher);

    const windows = BrowserWindowWatcher.iteratePlacesOwnerWindows();
    while (true) {
      const win = windows.next();
      if (win.done)
        break;
      BrowserWindowWatcher.unhandleWindow(win.value);
    }

    //const handler = Cc['@mozilla.org/network/protocol;1?name=resource'].getService(Components.interfaces.nsISubstitutingProtocolHandler);
    //handler.setSubstitution('waterfox-bridge', null);

    Services.prefs.removeObserver('', BrowserWindowWatcher);
  }
};
