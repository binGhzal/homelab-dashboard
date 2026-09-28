import { useRef, useState } from "react";
import {
  IconDots,
  IconFolder,
  IconX,
  IconPlus,
  IconSettings,
  IconLogout,
  IconSearch,
  IconChevronLeft,
  IconChevronRight,
  IconGripHorizontal,
  IconCheck,
} from "@tabler/icons-react";
import type { Folder, Preferences, PublicApp, User } from "../../shared/types";
import { AppIcon } from "./Icon";

function IconTile({ app, small = false }: { app: PublicApp; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  return (
    <span
      className={`app-icon${small ? " app-icon-small" : ""}`}
      style={{ "--app-color": app.color } as React.CSSProperties}
    >
      {app.iconPath && !broken ? (
        <img
          src={app.iconPath}
          alt=""
          onError={() => setBroken(true)}
          draggable={false}
        />
      ) : (
        <AppIcon name={app.icon} size={small ? 25 : 40} />
      )}
    </span>
  );
}
interface Props {
  user: User;
  apps: PublicApp[];
  preferences: Preferences;
  query: string;
  setQuery: (value: string) => void;
  save: (value: Preferences) => Promise<void>;
  saving: boolean;
  logout: () => void;
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
}: Props) {
  const [menu, setMenu] = useState<string | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [newName, setNewName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [rename, setRename] = useState<string | null>(null);
  const folderDialog = useRef<HTMLDialogElement>(null);
  const createDialog = useRef<HTMLDialogElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const demoDialog = useRef<HTMLDialogElement>(null);
  const searchDialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const byId = new Map(apps.map((app) => [app.id, app]));
  const byFolder = new Map(
    preferences.folders.map((folder) => [`folder:${folder.id}`, folder]),
  );
  const activeFolder = preferences.folders.find(
    (folder) => folder.id === openFolder,
  );
  const filtered = query.trim()
    ? apps.filter((app) =>
        `${app.name} ${app.description} ${app.category}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
    : null;
  function change(next: Preferences) {
    setMenu(null);
    void save(next);
  }
  function pin(id: string) {
    change({
      ...preferences,
      dock: preferences.dock.includes(id)
        ? preferences.dock.filter((value) => value !== id)
        : [...preferences.dock, id].slice(0, 8),
    });
  }
  function move(id: string, target: string) {
    if (id === target || saving) return;
    const targetFolder = byFolder.get(target);
    if (targetFolder && byId.has(id)) {
      const folders = preferences.folders.map((folder) => ({
        ...folder,
        appIds: [
          ...folder.appIds.filter((app) => app !== id),
          ...(folder.id === targetFolder.id ? [id] : []),
        ],
      }));
      change({
        ...preferences,
        folders,
        order: preferences.order.filter((item) => item !== id),
      });
      return;
    }
    const order = preferences.order.filter((item) => item !== id);
    const index = order.indexOf(target);
    if (index < 0) return;
    order.splice(index, 0, id);
    change({ ...preferences, order });
  }
  function nudge(id: string, direction: number) {
    const order = [...preferences.order];
    const from = order.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    change({ ...preferences, order });
  }
  function addFolder() {
    const id = `f-${crypto.randomUUID()}`;
    const selectedIds = selected.filter((value) => byId.has(value));
    if (!newName.trim() || !selectedIds.length) return;
    const folders = [
      ...preferences.folders.map((folder) => ({
        ...folder,
        appIds: folder.appIds.filter((app) => !selectedIds.includes(app)),
      })),
      { id, name: newName.trim(), appIds: selectedIds },
    ];
    const first = preferences.order.findIndex((item) =>
      selectedIds.includes(item),
    );
    const order = preferences.order.filter(
      (item) => !selectedIds.includes(item),
    );
    order.splice(Math.max(first, 0), 0, `folder:${id}`);
    change({ ...preferences, folders, order });
    createDialog.current?.close();
    setNewName("");
    setSelected([]);
  }
  function dissolve(folder: Folder) {
    change({
      ...preferences,
      folders: preferences.folders.filter((item) => item.id !== folder.id),
      order: preferences.order.flatMap((id) =>
        id === `folder:${folder.id}` ? folder.appIds : [id],
      ),
    });
    folderDialog.current?.close();
  }
  function removeFromFolder(id: string) {
    change({
      ...preferences,
      folders: preferences.folders.map((folder) => ({
        ...folder,
        appIds: folder.appIds.filter((app) => app !== id),
      })),
      order: [...preferences.order, id],
    });
  }
  function launch(event: React.MouseEvent<HTMLAnchorElement>) {
    if (user.demo) {
      event.preventDefault();
      demoDialog.current?.showModal();
    }
  }
  function startFolder(id: string) {
    setOpenFolder(id);
    setMenu(null);
    folderDialog.current?.showModal();
  }
  function openSearch() {
    searchDialog.current?.showModal();
    window.requestAnimationFrame(() => searchInput.current?.focus());
  }
  function folderPreview(folder: Folder) {
    return (
      <span className="folder-icon">
        {folder.appIds
          .slice(0, 4)
          .map((id) =>
            byId.has(id) ? (
              <IconTile key={id} app={byId.get(id)!} small />
            ) : null,
          )}
      </span>
    );
  }
  function appEntry(app: PublicApp, insideFolder = false) {
    return (
      <div
        className={`desktop-item${editing ? " edit-mode" : ""}`}
        key={app.id}
        draggable={!saving}
        onDragStart={(event) => {
          event.dataTransfer.setData("text/plain", app.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          move(event.dataTransfer.getData("text/plain"), app.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu(menu === app.id ? null : app.id);
        }}
      >
        <a
          className="launcher"
          href={app.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={launch}
          aria-label={`Open ${app.name}`}
        >
          <IconTile app={app} />
          <span className="app-name">{app.name}</span>
        </a>
        <button
          className="item-menu-button"
          aria-label={`Options for ${app.name}`}
          onClick={() => setMenu(menu === app.id ? null : app.id)}
        >
          <IconDots size={17} />
        </button>
        {menu === app.id && (
          <div
            className="context-menu"
            role="menu"
            aria-label={`${app.name} options`}
          >
            <button
              role="menuitem"
              onClick={() => pin(app.id)}
              disabled={
                !preferences.dock.includes(app.id) &&
                preferences.dock.length >= 8
              }
            >
              {preferences.dock.includes(app.id)
                ? "Remove from dock"
                : "Add to dock"}
            </button>
            {insideFolder ? (
              <button role="menuitem" onClick={() => removeFromFolder(app.id)}>
                Move to home
              </button>
            ) : (
              <>
                <button role="menuitem" onClick={() => nudge(app.id, -1)}>
                  Move earlier
                </button>
                <button role="menuitem" onClick={() => nudge(app.id, 1)}>
                  Move later
                </button>
              </>
            )}
            {preferences.folders
              .filter((folder) => !folder.appIds.includes(app.id))
              .map((folder) => (
                <button
                  role="menuitem"
                  key={folder.id}
                  onClick={() => move(app.id, `folder:${folder.id}`)}
                >
                  Move to {folder.name}
                </button>
              ))}
            <button
              role="menuitem"
              onClick={() => {
                setSelected([app.id]);
                setNewName("");
                createDialog.current?.showModal();
                setMenu(null);
              }}
            >
              New folder with this app
            </button>
            <button role="menuitem" onClick={() => setMenu(null)}>
              Close
            </button>
          </div>
        )}
      </div>
    );
  }
  const order = preferences.order.length
    ? preferences.order
    : apps.map((app) => app.id);
  return (
    <>
      <section
        className="desktop-apps"
        aria-label="Your apps"
        onClick={(event) => {
          if (event.target === event.currentTarget) setMenu(null);
        }}
      >
        {!order.length ? (
          <div className="empty-state">
            <IconFolder size={32} />
            <h2>Your apps will appear here</h2>
            <p>Your administrator can grant access to the apps you need.</p>
          </div>
        ) : (
          <div className="app-grid">
            {order.map((id) => {
              const folder = byFolder.get(id);
              if (folder)
                return (
                  <div
                    className={`desktop-item${editing ? " edit-mode" : ""}`}
                    key={id}
                    draggable={!saving}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", id);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      move(event.dataTransfer.getData("text/plain"), id);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu(menu === id ? null : id);
                    }}
                  >
                    <button
                      className="launcher folder-launcher"
                      onClick={() => startFolder(folder.id)}
                      aria-label={`Open folder ${folder.name}`}
                    >
                      {folderPreview(folder)}
                      <span className="app-name">{folder.name}</span>
                    </button>
                    <button
                      className="item-menu-button"
                      aria-label={`Options for folder ${folder.name}`}
                      onClick={() => setMenu(menu === id ? null : id)}
                    >
                      <IconDots size={17} />
                    </button>
                    {menu === id && (
                      <div className="context-menu" role="menu">
                        <button
                          role="menuitem"
                          onClick={() => {
                            setRename(folder.id);
                            setNewName(folder.name);
                            createDialog.current?.showModal();
                            setMenu(null);
                          }}
                        >
                          Rename folder
                        </button>
                        <button role="menuitem" onClick={() => nudge(id, -1)}>
                          Move earlier
                        </button>
                        <button role="menuitem" onClick={() => nudge(id, 1)}>
                          Move later
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => dissolve(folder)}
                        >
                          Remove folder, keep apps
                        </button>
                        <button role="menuitem" onClick={() => setMenu(null)}>
                          Close
                        </button>
                      </div>
                    )}
                  </div>
                );
              const app = byId.get(id);
              return app ? appEntry(app) : null;
            })}
          </div>
        )}
      </section>
      {editing && (
        <div className="editing-toolbar">
          <span>
            Drag apps to rearrange. Drop them onto a folder to organize.
          </span>
          <button
            className="text-button"
            onClick={() => {
              setRename(null);
              setSelected([]);
              setNewName("");
              createDialog.current?.showModal();
            }}
          >
            <IconPlus size={16} />
            New folder
          </button>
          <button className="text-button" onClick={() => setEditing(false)}>
            <IconCheck size={16} />
            Done
          </button>
        </div>
      )}
      <nav className="desktop-controls" aria-label="Desktop controls">
        <button className="search-pill" onClick={openSearch}>
          <IconSearch size={14} />
          Search<kbd>⌘ K</kbd>
        </button>
        <div className="desktop-dock">
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
              >
                <IconTile app={byId.get(id)!} small />
              </a>
            ) : null,
          )}
          <span className="dock-divider" />
          <button
            className="dock-action"
            onClick={() => settingsDialog.current?.showModal()}
            aria-label="Desktop settings"
            title="Settings"
          >
            <IconSettings size={26} stroke={1.5} />
          </button>
          <button
            className="dock-account"
            onClick={() => settingsDialog.current?.showModal()}
            aria-label="Your account"
            title={user.displayName}
          >
            {(user.givenName ?? user.displayName).slice(0, 1).toUpperCase()}
          </button>
        </div>
      </nav>
      <dialog
        className="desktop-dialog search-dialog"
        ref={searchDialog}
        onClose={() => setQuery("")}
      >
        <div className="search-dialog-header">
          <IconSearch size={21} />
          <label className="sr-only" htmlFor="desktop-search">
            Search your apps
          </label>
          <input
            id="desktop-search"
            ref={searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your apps"
            maxLength={120}
          />
          <button
            className="icon-button"
            onClick={() => searchDialog.current?.close()}
            aria-label="Close search"
          >
            <IconX size={20} />
          </button>
        </div>
        <div className="search-results">
          {(filtered ?? apps).map((app) => (
            <a
              key={app.id}
              href={app.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={launch}
            >
              <IconTile app={app} small />
              <span>
                {app.name}
                <small>{app.description}</small>
              </span>
              <IconChevronRight size={18} />
            </a>
          ))}
          {filtered?.length === 0 && (
            <p className="search-empty">No apps found. Try another name.</p>
          )}
        </div>
      </dialog>
      <dialog
        className="desktop-dialog folder-dialog"
        ref={folderDialog}
        onClose={() => {
          setOpenFolder(null);
          setMenu(null);
        }}
      >
        <div className="dialog-heading">
          <h2>{activeFolder?.name ?? "Folder"}</h2>
          <button
            className="icon-button"
            onClick={() => folderDialog.current?.close()}
            aria-label="Close folder"
          >
            <IconX size={22} />
          </button>
        </div>
        <div className="app-grid folder-app-grid">
          {activeFolder?.appIds.map((id) =>
            byId.has(id) ? appEntry(byId.get(id)!, true) : null,
          )}
        </div>
      </dialog>
      <dialog className="desktop-dialog settings-dialog" ref={settingsDialog}>
        <div className="dialog-heading">
          <h2>Settings</h2>
          <button
            className="icon-button"
            onClick={() => settingsDialog.current?.close()}
            aria-label="Close settings"
          >
            <IconX size={22} />
          </button>
        </div>
        <section className="settings-section">
          <h3>Wallpaper</h3>
          <div className="wallpaper-options">
            {(["landscape", "midnight", "dusk"] as const).map((value) => (
              <button
                key={value}
                className={`wallpaper-option wallpaper-${value}`}
                aria-label={`Use ${value} wallpaper`}
                aria-pressed={preferences.wallpaper === value}
                onClick={() => change({ ...preferences, wallpaper: value })}
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
              setEditing(true);
              settingsDialog.current?.close();
            }}
          >
            <IconGripHorizontal size={21} />
            <span>Rearrange apps</span>
            <IconChevronRight size={18} />
          </button>
          <button
            className="settings-row"
            onClick={() => {
              setRename(null);
              setSelected([]);
              setNewName("");
              createDialog.current?.showModal();
              settingsDialog.current?.close();
            }}
          >
            <IconFolder size={21} />
            <span>Create folder</span>
            <IconChevronRight size={18} />
          </button>
          <p className="settings-hint">
            Your layout follows your account across browsers. App access is
            managed by your administrator.
          </p>
        </section>
        <section className="settings-section">
          <h3>Account</h3>
          <div className="account-row">
            <span className="account-avatar">
              {(user.givenName ?? user.displayName).slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{user.displayName}</strong>
              <small>
                {user.demo
                  ? "Local preview account"
                  : "Signed in with your identity provider"}
              </small>
            </div>
          </div>
          <button className="settings-row" onClick={logout}>
            <IconLogout size={20} />
            <span>Sign out</span>
          </button>
        </section>
      </dialog>
      <dialog
        className="desktop-dialog create-folder-dialog"
        ref={createDialog}
        onClose={() => {
          setRename(null);
          setNewName("");
          setSelected([]);
        }}
      >
        <div className="dialog-heading">
          <h2>{rename ? "Rename folder" : "New folder"}</h2>
          <button
            className="icon-button"
            onClick={() => createDialog.current?.close()}
            aria-label="Cancel folder"
          >
            <IconX size={22} />
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (rename) {
              change({
                ...preferences,
                folders: preferences.folders.map((folder) =>
                  folder.id === rename
                    ? { ...folder, name: newName.trim() }
                    : folder,
                ),
              });
              createDialog.current?.close();
            } else addFolder();
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
          />
          {!rename && (
            <fieldset className="folder-app-selection">
              <legend>Choose apps</legend>
              {apps.map((app) => (
                <label key={app.id}>
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
                  <span>{app.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          <button
            className="button primary"
            type="submit"
            disabled={
              saving || !newName.trim() || (!rename && !selected.length)
            }
          >
            {rename ? "Save name" : "Create folder"}
          </button>
        </form>
      </dialog>
      <dialog ref={demoDialog} className="desktop-dialog demo-dialog">
        <div className="dialog-heading">
          <h2>Local preview</h2>
          <button
            className="icon-button"
            aria-label="Close preview information"
            onClick={() => demoDialog.current?.close()}
          >
            <IconX size={22} />
          </button>
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
      <KeyboardSearch open={openSearch} closeMenu={() => setMenu(null)} />
    </>
  );
}
import { useEffect } from "react";
function KeyboardSearch({
  open,
  closeMenu,
}: {
  open: () => void;
  closeMenu: () => void;
}) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [open, closeMenu]);
  return null;
}
