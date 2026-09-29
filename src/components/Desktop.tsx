import { useEffect, useRef, useState, type RefObject } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconArrowDown,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconExternalLink,
  IconFolder,
  IconFolderPlus,
  IconGripHorizontal,
  IconHome,
  IconLayoutGrid,
  IconLogout,
  IconPhoto,
  IconPin,
  IconPlus,
  IconSearch,
  IconSettings,
  IconX,
} from "@tabler/icons-react";
import type { Folder, Preferences, PublicApp, User } from "../../shared/types";
import { AppArtwork } from "./AppArtwork";
import { DesktopMenu, type MenuAction, type MenuAnchor } from "./DesktopMenu";

type DialogRef = RefObject<HTMLDialogElement | null>;
interface Props {
  user: User;
  apps: PublicApp[];
  preferences: Preferences;
  query: string;
  setQuery: (value: string) => void;
  save: (value: Preferences) => Promise<boolean>;
  saving: boolean;
  logout: () => void;
  error: string;
  refresh: () => void;
}

export function Desktop({
  user,
  apps,
  preferences,
  query,
  setQuery,
  save,
  saving,
  logout,
  error,
  refresh,
}: Props) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [rename, setRename] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [dragged, setDragged] = useState<string | null>(null);
  const account = useRef<HTMLButtonElement>(null);
  const folderDialog = useRef<HTMLDialogElement>(null);
  const createDialog = useRef<HTMLDialogElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const dockDialog = useRef<HTMLDialogElement>(null);
  const demoDialog = useRef<HTMLDialogElement>(null);
  const searchDialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const returns = useRef(new WeakMap<HTMLDialogElement, HTMLElement>());
  const byId = new Map(apps.map((app) => [app.id, app]));
  const byFolder = new Map(
    preferences.folders.map((folder) => [`folder:${folder.id}`, folder]),
  );
  const activeFolder = preferences.folders.find(
    (folder) => folder.id === openFolder,
  );
  const order = preferences.order.length
    ? preferences.order
    : apps.map((app) => app.id);
  const searchTerm = query.trim().toLocaleLowerCase();
  const filtered = apps.filter((app) =>
    `${app.name} ${app.description} ${app.category}`
      .toLocaleLowerCase()
      .includes(searchTerm),
  );
  const matchingFolders = searchTerm
    ? preferences.folders.filter((folder) =>
        folder.name.toLocaleLowerCase().includes(searchTerm),
      )
    : [];

  function show(ref: DialogRef, trigger?: HTMLElement | null) {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    const previous = trigger ?? document.activeElement;
    if (previous instanceof HTMLElement) returns.current.set(dialog, previous);
    dialog.showModal();
  }
  function closed(ref: DialogRef) {
    const target = ref.current && returns.current.get(ref.current);
    if (target?.isConnected && !target.closest("dialog:not([open])"))
      target.focus();
    else account.current?.focus();
  }
  function closeMenu(restore = false) {
    if (restore && menu?.trigger.isConnected) menu.trigger.focus();
    setMenu(null);
  }
  function toggleMenu(
    id: string,
    trigger: HTMLElement,
    point?: { x: number; y: number },
  ) {
    setMenu((current) => (current?.id === id ? null : { id, trigger, point }));
  }
  async function change(next: Preferences, message: string) {
    if (saving) return false;
    const saved = await save(next);
    if (saved) setAnnouncement(message);
    return saved;
  }
  function pin(id: string) {
    if (
      saving ||
      (!preferences.dock.includes(id) && preferences.dock.length >= 8)
    )
      return;
    const pinned = preferences.dock.includes(id);
    void change(
      {
        ...preferences,
        dock: pinned
          ? preferences.dock.filter((value) => value !== id)
          : [...preferences.dock, id],
      },
      `${byId.get(id)?.name} ${pinned ? "removed from" : "added to"} dock.`,
    );
  }
  function moveDock(id: string, direction: number) {
    const dock = [...preferences.dock];
    const from = dock.indexOf(id),
      to = from + direction;
    if (from < 0 || to < 0 || to >= dock.length) return;
    [dock[from], dock[to]] = [dock[to], dock[from]];
    void change(
      { ...preferences, dock },
      `${byId.get(id)?.name} moved ${direction < 0 ? "earlier" : "later"} in dock.`,
    );
  }
  function dropInDock(id: string, before?: string) {
    if (
      !byId.has(id) ||
      id === before ||
      saving ||
      (!preferences.dock.includes(id) && preferences.dock.length >= 8)
    )
      return;
    const dock = preferences.dock.filter((value) => value !== id);
    const index = before ? dock.indexOf(before) : dock.length;
    dock.splice(index < 0 ? dock.length : index, 0, id);
    void change(
      { ...preferences, dock },
      `${byId.get(id)?.name} placed in dock.`,
    );
  }
  function move(id: string, target: string) {
    if (id === target || saving || (!byId.has(id) && !byFolder.has(id))) return;
    const targetFolder = byFolder.get(target);
    if (targetFolder && byId.has(id)) {
      const folders = preferences.folders.map((folder) => ({
        ...folder,
        appIds: [
          ...folder.appIds.filter((app) => app !== id),
          ...(folder.id === targetFolder.id ? [id] : []),
        ],
      }));
      void change(
        { ...preferences, folders, order: order.filter((item) => item !== id) },
        `${byId.get(id)?.name} moved to ${targetFolder.name}.`,
      );
      return;
    }
    const containingFolder = preferences.folders.find((folder) =>
      folder.appIds.includes(target),
    );
    if (containingFolder) {
      if (!byId.has(id)) return;
      const folders = preferences.folders.map((folder) => {
        const appIds = folder.appIds.filter((app) => app !== id);
        if (folder.id === containingFolder.id)
          appIds.splice(appIds.indexOf(target), 0, id);
        return { ...folder, appIds };
      });
      void change(
        { ...preferences, folders, order: order.filter((item) => item !== id) },
        "Folder order saved.",
      );
      return;
    }
    const next = order.filter((item) => item !== id);
    const index = next.indexOf(target);
    if (index < 0) return;
    next.splice(index, 0, id);
    void change(
      {
        ...preferences,
        folders: preferences.folders.map((folder) => ({
          ...folder,
          appIds: folder.appIds.filter((app) => app !== id),
        })),
        order: next,
      },
      "App order saved.",
    );
  }
  function canNudge(id: string, direction: number) {
    const list =
      preferences.folders.find((folder) => folder.appIds.includes(id))
        ?.appIds ?? order;
    const index = list.indexOf(id);
    return (
      !saving &&
      index >= 0 &&
      index + direction >= 0 &&
      index + direction < list.length
    );
  }
  function nudge(id: string, direction: number) {
    if (!canNudge(id, direction)) return;
    const folder = preferences.folders.find((item) => item.appIds.includes(id));
    const list = [...(folder?.appIds ?? order)];
    const from = list.indexOf(id),
      to = from + direction;
    [list[from], list[to]] = [list[to], list[from]];
    void change(
      folder
        ? {
            ...preferences,
            folders: preferences.folders.map((item) =>
              item.id === folder.id ? { ...item, appIds: list } : item,
            ),
          }
        : { ...preferences, order: list },
      `${byId.get(id)?.name ?? byFolder.get(id)?.name} moved ${direction < 0 ? "earlier" : "later"}.`,
    );
  }
  function newFolder(trigger?: HTMLElement | null, appId?: string) {
    setRename(null);
    setNewName("");
    setSelected(appId ? [appId] : []);
    show(createDialog, trigger);
    requestAnimationFrame(() =>
      createDialog.current
        ?.querySelector<HTMLInputElement>("#folder-name")
        ?.focus(),
    );
  }
  async function submitFolder() {
    if (!newName.trim() || saving) return;
    if (rename) {
      if (
        await change(
          {
            ...preferences,
            folders: preferences.folders.map((folder) =>
              folder.id === rename
                ? { ...folder, name: newName.trim() }
                : folder,
            ),
          },
          "Folder renamed.",
        )
      )
        createDialog.current?.close();
      return;
    }
    const selectedIds = selected.filter((id) => byId.has(id));
    if (!selectedIds.length || preferences.folders.length >= 30) return;
    const id = `f-${crypto.randomUUID()}`;
    const folders = [
      ...preferences.folders.map((folder) => ({
        ...folder,
        appIds: folder.appIds.filter((app) => !selectedIds.includes(app)),
      })),
      { id, name: newName.trim(), appIds: selectedIds },
    ];
    const first = order.findIndex((item) => selectedIds.includes(item));
    const next = order.filter((item) => !selectedIds.includes(item));
    next.splice(Math.max(first, 0), 0, `folder:${id}`);
    if (
      await change(
        { ...preferences, folders, order: next },
        `${newName.trim()} folder created.`,
      )
    )
      createDialog.current?.close();
  }
  async function dissolve(folder: Folder) {
    if (
      await change(
        {
          ...preferences,
          folders: preferences.folders.filter((item) => item.id !== folder.id),
          order: order.flatMap((id) =>
            id === `folder:${folder.id}` ? folder.appIds : [id],
          ),
        },
        "Folder removed. Its apps are on your desktop.",
      )
    )
      folderDialog.current?.close();
  }
  function removeFromFolder(id: string) {
    void change(
      {
        ...preferences,
        folders: preferences.folders.map((folder) => ({
          ...folder,
          appIds: folder.appIds.filter((app) => app !== id),
        })),
        order: [...order, id],
      },
      `${byId.get(id)?.name} moved to desktop.`,
    );
  }
  function launch(event: React.MouseEvent<HTMLAnchorElement>) {
    if (user.demo) {
      event.preventDefault();
      const trigger = searchDialog.current?.open
        ? returns.current.get(searchDialog.current)
        : event.currentTarget;
      searchDialog.current?.close();
      show(demoDialog, trigger);
    }
  }
  function startFolder(id: string, trigger?: HTMLElement | null) {
    setOpenFolder(id);
    setMenu(null);
    show(folderDialog, trigger);
  }
  function openSearch() {
    if (searchDialog.current?.open) {
      searchDialog.current.close();
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    setMenu(null);
    show(searchDialog);
    searchInput.current?.focus();
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
      if (event.key === "Escape" && !document.querySelector("dialog[open]"))
        setEditing(false);
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  });
  useEffect(() => {
    if (
      openFolder &&
      !preferences.folders.some((folder) => folder.id === openFolder)
    )
      folderDialog.current?.close();
  }, [openFolder, preferences.folders]);

  function desktopActions(
    getTrigger: () => HTMLElement | null | undefined = () => account.current,
  ): (MenuAction & { keywords: string })[] {
    return [
      {
        label: "Desktop settings",
        keywords: "preferences personalization",
        icon: <IconSettings size={18} />,
        onSelect: () => show(settingsDialog, getTrigger()),
      },
      {
        label: "Rearrange apps",
        keywords: "reorder organize move",
        icon: <IconGripHorizontal size={18} />,
        disabled: !apps.length,
        onSelect: () => {
          setEditing(true);
          getTrigger()?.focus();
        },
      },
      {
        label: "New folder",
        keywords: "create group organize",
        icon: <IconFolderPlus size={18} />,
        disabled: saving || !apps.length || preferences.folders.length >= 30,
        onSelect: () => newFolder(getTrigger()),
      },
      {
        label: "Customize dock",
        keywords: "favorites pin shortcuts",
        icon: <IconLayoutGrid size={18} />,
        onSelect: () => show(dockDialog, getTrigger()),
      },
      {
        label: "Change wallpaper",
        keywords: "background theme appearance",
        icon: <IconPhoto size={18} />,
        onSelect: () => show(settingsDialog, getTrigger()),
      },
    ];
  }
  const searchActions = desktopActions(
    () => searchDialog.current && returns.current.get(searchDialog.current),
  ).filter((action) =>
    `${action.label} ${action.keywords}`
      .toLocaleLowerCase()
      .includes(searchTerm),
  );

  const actionsFor = (id: string): MenuAction[] => {
    const app = byId.get(id),
      folder = byFolder.get(id);
    if (app) {
      const inFolder = preferences.folders.some((item) =>
        item.appIds.includes(id),
      );
      return [
        {
          label: preferences.dock.includes(id)
            ? "Remove from dock"
            : "Add to dock",
          icon: <IconPin size={18} />,
          disabled:
            saving ||
            (!preferences.dock.includes(id) && preferences.dock.length >= 8),
          onSelect: () => pin(id),
        },
        {
          label: "Move earlier",
          icon: <IconArrowLeft size={18} />,
          shortcut: "⌥ ←",
          disabled: !canNudge(id, -1),
          onSelect: () => nudge(id, -1),
        },
        {
          label: "Move later",
          icon: <IconArrowRight size={18} />,
          shortcut: "⌥ →",
          disabled: !canNudge(id, 1),
          onSelect: () => nudge(id, 1),
        },
        ...(inFolder
          ? [
              {
                label: "Move to home",
                icon: <IconHome size={18} />,
                disabled: saving,
                onSelect: () => removeFromFolder(id),
              },
            ]
          : []),
        ...preferences.folders
          .filter((item) => !item.appIds.includes(id))
          .map((item) => ({
            id: `move-to-folder:${item.id}`,
            label: `Move to ${item.name}`,
            icon: <IconFolder size={18} />,
            disabled: saving,
            onSelect: () => move(id, `folder:${item.id}`),
          })),
        {
          label: "New folder with this app",
          icon: <IconFolderPlus size={18} />,
          separator: true,
          disabled: saving || preferences.folders.length >= 30,
          onSelect: () => newFolder(menu?.trigger, id),
        },
      ];
    }
    if (folder)
      return [
        {
          label: "Rename folder",
          icon: <IconFolder size={18} />,
          disabled: saving,
          onSelect: () => {
            setRename(folder.id);
            setNewName(folder.name);
            show(createDialog, menu?.trigger);
            requestAnimationFrame(() =>
              createDialog.current
                ?.querySelector<HTMLInputElement>("#folder-name")
                ?.select(),
            );
          },
        },
        {
          label: "Move earlier",
          icon: <IconArrowLeft size={18} />,
          disabled: !canNudge(id, -1),
          onSelect: () => nudge(id, -1),
        },
        {
          label: "Move later",
          icon: <IconArrowRight size={18} />,
          disabled: !canNudge(id, 1),
          onSelect: () => nudge(id, 1),
        },
        {
          label: "Remove folder, keep apps",
          icon: <IconX size={18} />,
          separator: true,
          disabled: saving,
          onSelect: () => void dissolve(folder),
        },
      ];
    const common: MenuAction[] = desktopActions();
    if (id === "ui:account")
      common.push({
        label: "Sign out",
        icon: <IconLogout size={18} />,
        separator: true,
        onSelect: logout,
      });
    return common;
  };

  function tile(id: string) {
    const app = byId.get(id),
      folder = byFolder.get(id);
    if (!app && !folder) return null;
    const name = app?.name ?? folder!.name;
    return (
      <div
        className={`desktop-item${editing ? " edit-mode" : ""}${dragged === id ? " is-dragging" : ""}`}
        key={id}
        draggable={!saving}
        onDragStart={(event) => {
          setDragged(id);
          setMenu(null);
          event.dataTransfer.setData("text/plain", id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDragged(null)}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragged(null);
          move(event.dataTransfer.getData("text/plain"), id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleMenu(
            id,
            event.currentTarget.querySelector<HTMLElement>(
              ".item-menu-button",
            )!,
            { x: event.clientX, y: event.clientY },
          );
        }}
        onKeyDown={(event) => {
          if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            nudge(id, event.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        {app ? (
          <a
            className="launcher"
            href={app.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={launch}
            aria-label={`Open ${app.name}`}
            draggable={false}
          >
            <AppArtwork app={app} />
            <span className="app-name">{app.name}</span>
          </a>
        ) : (
          <button
            className="launcher folder-launcher"
            onClick={(event) => startFolder(folder!.id, event.currentTarget)}
            aria-label={`Open folder ${folder!.name}`}
          >
            <span className="folder-icon">
              {folder!.appIds
                .slice(0, 4)
                .map((appId) =>
                  byId.has(appId) ? (
                    <AppArtwork key={appId} app={byId.get(appId)!} small />
                  ) : null,
                )}
            </span>
            <span className="app-name">{folder!.name}</span>
          </button>
        )}
        <button
          className="item-menu-button"
          aria-label={`Options for ${folder ? "folder " : ""}${name}`}
          aria-haspopup="menu"
          aria-expanded={menu?.id === id}
          onClick={(event) => toggleMenu(id, event.currentTarget)}
        >
          <IconDots size={18} />
        </button>
        {editing && (
          <div className="reorder-buttons">
            <button
              aria-label={`Move ${name} earlier`}
              disabled={!canNudge(id, -1)}
              onClick={() => nudge(id, -1)}
            >
              <IconArrowLeft size={16} />
            </button>
            <button
              aria-label={`Move ${name} later`}
              disabled={!canNudge(id, 1)}
              onClick={() => nudge(id, 1)}
            >
              <IconArrowRight size={16} />
            </button>
          </div>
        )}
      </div>
    );
  }
  const dialogError = error ? (
    <div className="notice dialog-notice" role="alert">
      <span>{error}</span>
      <button className="text-button" onClick={refresh}>
        Refresh layout
      </button>
    </div>
  ) : null;
  const closeButton = (ref: DialogRef, label: string) => (
    <button
      className="icon-button"
      aria-label={label}
      onClick={() => ref.current?.close()}
    >
      <IconX size={21} />
    </button>
  );
  return (
    <>
      <header className="desktop-topbar">
        <span className="desktop-brand">
          <IconHome size={21} stroke={1.7} />
          <span>{user.title}</span>
        </span>
        <button
          ref={account}
          className="account-trigger"
          aria-label="Your account"
          aria-haspopup="menu"
          aria-expanded={menu?.id === "ui:account"}
          onClick={(event) => toggleMenu("ui:account", event.currentTarget)}
        >
          <span className="account-avatar">
            {(user.givenName ?? user.displayName)
              .slice(0, 1)
              .toLocaleUpperCase()}
          </span>
          <span className="account-name">
            {user.givenName ?? user.displayName}
          </span>
          <IconChevronDown size={15} />
        </button>
      </header>
      <section
        className="desktop-apps"
        aria-label="Your apps"
        onContextMenu={(event) => {
          if (
            !(event.target as HTMLElement).closest("button,a,.desktop-item")
          ) {
            event.preventDefault();
            toggleMenu("ui:desktop", account.current!, {
              x: event.clientX,
              y: event.clientY,
            });
          }
        }}
      >
        <div className="apps-heading">
          <h2>
            Your apps <span>{apps.length}</span>
          </h2>
          <div className="apps-actions">
            <button
              className="quiet-button"
              disabled={
                saving || !apps.length || preferences.folders.length >= 30
              }
              onClick={(event) => newFolder(event.currentTarget)}
            >
              <IconFolderPlus size={17} />
              <span>New folder</span>
            </button>
            <button
              className={`quiet-button${editing ? " is-selected" : ""}`}
              aria-pressed={editing}
              disabled={!apps.length}
              onClick={() => setEditing(!editing)}
            >
              {editing ? (
                <IconCheck size={17} />
              ) : (
                <IconGripHorizontal size={17} />
              )}
              <span>{editing ? "Done" : "Rearrange"}</span>
            </button>
          </div>
        </div>
        {editing && (
          <p className="editing-hint">
            Drag to reorder or move apps into a folder. Use the arrow buttons,
            or Alt + ← / →, with a keyboard.
          </p>
        )}
        {!order.length ? (
          <div className="empty-state">
            <IconLayoutGrid size={32} />
            <h3>Your apps will appear here</h3>
            <p>Your administrator can grant access to the apps you need.</p>
          </div>
        ) : (
          <div className="app-grid">{order.map(tile)}</div>
        )}
      </section>
      <nav className="desktop-controls" aria-label="Desktop controls">
        <button className="search-pill" onClick={openSearch}>
          <IconSearch size={15} />
          Search<kbd>⌘ / Ctrl K</kbd>
        </button>
        <div
          className={`desktop-dock${preferences.dock.length ? "" : " empty-dock"}${dragged ? " dock-drop-ready" : ""}`}
          aria-label="Pinned apps"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            dropInDock(event.dataTransfer.getData("text/plain"));
            setDragged(null);
          }}
        >
          {preferences.dock.map((id) =>
            byId.has(id) ? (
              <a
                className="dock-app"
                key={id}
                href={byId.get(id)!.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={launch}
                aria-label={`Open ${byId.get(id)!.name} from dock`}
                title={byId.get(id)!.name}
                draggable={!saving}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", id);
                  setDragged(id);
                }}
                onDragEnd={() => setDragged(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  dropInDock(event.dataTransfer.getData("text/plain"), id);
                  setDragged(null);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  toggleMenu(id, event.currentTarget, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <AppArtwork app={byId.get(id)!} small />
                <span className="dock-tooltip">{byId.get(id)!.name}</span>
              </a>
            ) : null,
          )}
          {!preferences.dock.length && (
            <span>Pin your favorite apps from their options menu.</span>
          )}
        </div>
      </nav>
      {menu && (
        <DesktopMenu
          anchor={menu}
          label={
            menu.id === "ui:account"
              ? "Account menu"
              : menu.id === "ui:desktop"
                ? "Desktop options"
                : `${byId.get(menu.id)?.name ?? byFolder.get(menu.id)?.name} options`
          }
          header={
            menu.id === "ui:account" ? (
              <>
                <strong>{user.displayName}</strong>
                <small>
                  {user.demo ? "Preview account" : "Your personal desktop"}
                </small>
              </>
            ) : undefined
          }
          actions={actionsFor(menu.id)}
          close={closeMenu}
        />
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>

      <dialog
        className="desktop-dialog search-dialog"
        aria-label="Search apps and actions"
        ref={searchDialog}
        onClose={() => {
          setQuery("");
          closed(searchDialog);
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            const results = [
              ...(searchDialog.current?.querySelectorAll<HTMLElement>(
                "[data-search-result]:not(:disabled)",
              ) ?? []),
            ];
            const index = results.indexOf(
              document.activeElement as HTMLElement,
            );
            event.preventDefault();
            const next =
              event.key === "ArrowDown"
                ? Math.min(index + 1, results.length - 1)
                : index - 1;
            if (next < 0) searchInput.current?.focus();
            else results[next]?.focus();
          } else if (
            event.key === "Enter" &&
            event.target === searchInput.current
          ) {
            event.preventDefault();
            searchDialog.current
              ?.querySelector<HTMLElement>(
                "[data-search-result]:not(:disabled)",
              )
              ?.click();
          }
        }}
      >
        <div className="search-dialog-header">
          <IconSearch size={22} />
          <label className="sr-only" htmlFor="desktop-search">
            Search apps and actions
          </label>
          <input
            id="desktop-search"
            ref={searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps and actions"
            maxLength={120}
            autoComplete="off"
          />
          {closeButton(searchDialog, "Close search")}
        </div>
        <div className="search-results">
          {(filtered.length > 0 || matchingFolders.length > 0) && (
            <div className="search-section-label" role="heading" aria-level={3}>
              Apps
              <span>{filtered.length + matchingFolders.length}</span>
            </div>
          )}
          {matchingFolders.map((folder) => (
            <button
              data-search-result
              className="search-result"
              key={folder.id}
              onClick={() => {
                const trigger =
                  searchDialog.current &&
                  returns.current.get(searchDialog.current);
                searchDialog.current?.close();
                startFolder(folder.id, trigger);
              }}
            >
              <span className="search-folder">
                <IconFolder size={24} />
              </span>
              <span>
                {folder.name}
                <small>{folder.appIds.length} apps · Folder</small>
              </span>
              <IconChevronRight size={18} />
            </button>
          ))}
          {filtered.map((app) => (
            <a
              data-search-result
              className="search-result"
              key={app.id}
              href={app.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={launch}
            >
              <AppArtwork app={app} small />
              <span>
                {app.name}
                <small>{app.description}</small>
              </span>
              <IconExternalLink size={17} />
            </a>
          ))}
          {searchActions.length > 0 && (
            <div className="search-section-label" role="heading" aria-level={3}>
              Actions
              <span>{searchActions.length}</span>
            </div>
          )}
          {searchActions.map((action) => (
            <button
              data-search-result
              className="search-result search-action"
              key={action.label}
              disabled={action.disabled}
              onClick={() => {
                searchDialog.current?.close();
                action.onSelect();
              }}
            >
              <span className="search-action-icon">{action.icon}</span>
              <span>{action.label}</span>
              <IconChevronRight size={18} />
            </button>
          ))}
          {!filtered.length &&
            !matchingFolders.length &&
            !searchActions.length && (
              <div className="search-empty">
                <IconSearch size={27} />
                <strong>No results found</strong>
                <span>Try another app, folder, or action.</span>
              </div>
            )}
        </div>
        <div className="search-shortcuts">
          <span>↑ ↓ to navigate</span>
          <span>↵ to open</span>
          <span>esc to close</span>
        </div>
      </dialog>
      <dialog
        className="desktop-dialog folder-dialog"
        aria-labelledby="open-folder-title"
        ref={folderDialog}
        onClose={() => {
          setOpenFolder(null);
          setMenu(null);
          closed(folderDialog);
        }}
      >
        <div className="dialog-heading">
          <div>
            <h2 id="open-folder-title">{activeFolder?.name ?? "Folder"}</h2>
            <p>{activeFolder?.appIds.length ?? 0} apps</p>
          </div>
          {closeButton(folderDialog, "Close folder")}
        </div>
        {dialogError}
        <div className="app-grid folder-app-grid">
          {activeFolder?.appIds.map(tile)}
        </div>
      </dialog>
      <dialog
        className="desktop-dialog settings-dialog"
        aria-labelledby="settings-title"
        ref={settingsDialog}
        onClose={() => closed(settingsDialog)}
      >
        <div className="dialog-heading">
          <div>
            <h2 id="settings-title">Settings</h2>
            <p>Make yourself at home.</p>
          </div>
          {closeButton(settingsDialog, "Close settings")}
        </div>
        {dialogError}
        <section className="settings-section">
          <h3>Wallpaper</h3>
          <div className="wallpaper-options">
            {(["landscape", "midnight", "dusk"] as const).map((value) => (
              <button
                key={value}
                className={`wallpaper-option wallpaper-${value}`}
                aria-label={`Use ${value} wallpaper`}
                aria-pressed={preferences.wallpaper === value}
                disabled={saving}
                onClick={() =>
                  void change(
                    { ...preferences, wallpaper: value },
                    "Wallpaper saved.",
                  )
                }
              >
                <span>{value[0].toUpperCase() + value.slice(1)}</span>
                {preferences.wallpaper === value && <IconCheck size={18} />}
              </button>
            ))}
          </div>
        </section>
        <section className="settings-section">
          <h3>Your desktop</h3>
          <button
            className="settings-row"
            onClick={() => {
              settingsDialog.current?.close();
              setEditing(true);
            }}
          >
            <IconGripHorizontal size={21} />
            <span>Rearrange apps</span>
            <IconChevronRight size={18} />
          </button>
          <button
            className="settings-row"
            disabled={
              !apps.length || saving || preferences.folders.length >= 30
            }
            onClick={() => {
              settingsDialog.current?.close();
              newFolder(account.current);
            }}
          >
            <IconFolderPlus size={21} />
            <span>Create folder</span>
            <IconChevronRight size={18} />
          </button>
          <button
            className="settings-row"
            onClick={() => {
              settingsDialog.current?.close();
              show(dockDialog, account.current);
            }}
          >
            <IconLayoutGrid size={21} />
            <span>Customize dock</span>
            <IconChevronRight size={18} />
          </button>
          <p className="settings-hint">
            Your folders, favorites and wallpaper follow your account across
            browsers.
          </p>
        </section>
        <p className="settings-icon-credit">
          Icons:{" "}
          <a
            href="https://selfh.st/icons/"
            target="_blank"
            rel="noopener noreferrer"
          >
            selfh.st
          </a>
        </p>
      </dialog>
      <dialog
        className="desktop-dialog dock-dialog"
        aria-labelledby="dock-title"
        ref={dockDialog}
        onClose={() => closed(dockDialog)}
      >
        <div className="dialog-heading">
          <div>
            <h2 id="dock-title">Customize dock</h2>
            <p>
              Your favorites, always within reach. {preferences.dock.length} of
              8 pinned.
            </p>
          </div>
          {closeButton(dockDialog, "Close dock customization")}
        </div>
        {dialogError}
        <section className="settings-section">
          <h3>Pinned apps</h3>
          {preferences.dock.length ? (
            <ol className="dock-list">
              {preferences.dock.map((id, index) => {
                const app = byId.get(id);
                return app ? (
                  <li key={id}>
                    <AppArtwork app={app} small />
                    <span>{app.name}</span>
                    <div className="dock-order-actions">
                      <button
                        className="icon-button"
                        aria-label={`Move ${app.name} earlier in dock`}
                        disabled={saving || index === 0}
                        onClick={() => moveDock(id, -1)}
                      >
                        <IconArrowUp size={17} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Move ${app.name} later in dock`}
                        disabled={
                          saving || index === preferences.dock.length - 1
                        }
                        onClick={() => moveDock(id, 1)}
                      >
                        <IconArrowDown size={17} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Remove ${app.name} from dock`}
                        disabled={saving}
                        onClick={() => pin(id)}
                      >
                        <IconX size={18} />
                      </button>
                    </div>
                  </li>
                ) : null;
              })}
            </ol>
          ) : (
            <p className="settings-hint">
              Choose an app below to start your dock.
            </p>
          )}
        </section>
        <section className="settings-section">
          <h3>More apps</h3>
          <div className="available-dock-apps">
            {apps
              .filter((app) => !preferences.dock.includes(app.id))
              .map((app) => (
                <button
                  className="dock-choice"
                  key={app.id}
                  aria-label={`Add ${app.name} to dock`}
                  disabled={saving || preferences.dock.length >= 8}
                  onClick={() => pin(app.id)}
                >
                  <AppArtwork app={app} small />
                  <span>{app.name}</span>
                  <IconPlus size={19} />
                </button>
              ))}
          </div>
          {preferences.dock.length >= 8 && (
            <p className="settings-hint">
              Your dock is full. Remove an app to make room.
            </p>
          )}
        </section>
      </dialog>
      <dialog
        className="desktop-dialog create-folder-dialog"
        aria-labelledby="create-folder-title"
        ref={createDialog}
        onClose={() => {
          setRename(null);
          setNewName("");
          setSelected([]);
          closed(createDialog);
        }}
      >
        <div className="dialog-heading">
          <div>
            <h2 id="create-folder-title">
              {rename ? "Rename folder" : "New folder"}
            </h2>
            <p>
              {rename
                ? "Give this collection a new name."
                : "Keep the apps you use together in one place."}
            </p>
          </div>
          {closeButton(createDialog, "Cancel folder")}
        </div>
        {dialogError}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitFolder();
          }}
        >
          <label className="field-label" htmlFor="folder-name">
            Folder name
          </label>
          <input
            className="text-input"
            id="folder-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            maxLength={40}
            required
            autoComplete="off"
            placeholder="e.g. Everyday"
          />
          {!rename && (
            <fieldset className="folder-app-selection">
              <legend>
                Choose apps <span>{selected.length} selected</span>
              </legend>
              {apps.map((app) => (
                <label
                  key={app.id}
                  className={
                    selected.includes(app.id) ? "is-selected" : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(app.id)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, app.id]
                          : selected.filter((id) => id !== app.id),
                      )
                    }
                  />
                  <AppArtwork app={app} small />
                  <span>{app.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="dialog-form-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => createDialog.current?.close()}
            >
              Cancel
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={
                saving || !newName.trim() || (!rename && !selected.length)
              }
            >
              {saving ? "Saving…" : rename ? "Save name" : "Create folder"}
            </button>
          </div>
        </form>
      </dialog>
      <dialog
        ref={demoDialog}
        className="desktop-dialog demo-dialog"
        aria-labelledby="demo-title"
        onClose={() => closed(demoDialog)}
      >
        <div className="dialog-heading">
          <h2 id="demo-title">Local preview</h2>
          {closeButton(demoDialog, "Close preview information")}
        </div>
        <p>
          These app addresses are examples. In your deployment, launchers open
          your permitted applications.
        </p>
        <button
          className="button primary"
          onClick={() => demoDialog.current?.close()}
        >
          Back to desktop
        </button>
      </dialog>
    </>
  );
}
