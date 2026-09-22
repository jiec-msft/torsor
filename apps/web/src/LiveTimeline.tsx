import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ConnectionState } from "./controller";
import { timelineItems } from "./timeline-model";
import type { RunProjection } from "./types";
import "./timeline.css";

interface LiveTimelineProps {
  readonly projection: RunProjection;
  readonly loadingHistory: boolean;
  readonly historyError: string | null;
  readonly refreshError: string | null;
  readonly refreshing: boolean;
  readonly connection: ConnectionState;
  readonly onLoadEarlier: () => void;
  readonly onRefresh: () => void;
}

interface ScrollAnchor {
  readonly id: string;
  readonly offset: number;
}

export function LiveTimeline(props: LiveTimelineProps) {
  return <Timeline key={props.projection.run.id} {...props} />;
}

function Timeline({
  projection, loadingHistory, historyError, refreshError, refreshing,
  connection, onLoadEarlier, onRefresh,
}: LiveTimelineProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLOListElement>(null);
  const anchor = useRef<ScrollAnchor | null>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const items = useMemo(() => timelineItems(projection), [projection]);

  function rememberAnchor() {
    const region = viewport.current;
    if (!region) return;
    const top = region.getBoundingClientRect().top;
    const visible = Array.from(region.querySelectorAll<HTMLElement>("[data-timeline-id]"))
      .find((item) => item.getBoundingClientRect().bottom > top);
    anchor.current = visible
      ? { id: visible.dataset.timelineId!, offset: visible.getBoundingClientRect().top - top }
      : null;
  }

  function restorePosition() {
    const region = viewport.current;
    if (!region) return;
    if (follow.current) {
      region.scrollTop = region.scrollHeight;
    } else if (anchor.current) {
      const saved = anchor.current;
      const item = Array.from(region.querySelectorAll<HTMLElement>("[data-timeline-id]"))
        .find((candidate) => candidate.dataset.timelineId === saved.id);
      if (item) {
        region.scrollTop += item.getBoundingClientRect().top -
          region.getBoundingClientRect().top - saved.offset;
      }
    }
    rememberAnchor();
  }

  useLayoutEffect(() => {
    restorePosition();
  });

  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(restorePosition);
    observer.observe(viewport.current!);
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);

  function setFollow(value: boolean) {
    follow.current = value;
    setFollowing(value);
  }

  return (
    <section className="live-timeline">
      <div className="timeline-toolbar">
        <h3>Live Agent Timeline</h3>
        <span role="status">{following ? "Following latest" : "Reading history"}</span>
        <button type="button" disabled={following} onClick={() => {
          setFollow(true);
          restorePosition();
        }}>Back to latest</button>
        {projection.activity.hasEarlier ? (
          <button type="button" disabled={loadingHistory} onClick={() => {
            rememberAnchor();
            setFollow(false);
            onLoadEarlier();
          }}>
            {loadingHistory ? "Loading earlier activity..." : historyError ? "Retry earlier activity" : "Load earlier activity"}
          </button>
        ) : <small>All retained activity loaded</small>}
      </div>
      {connection !== "live" ? (
        <p className="timeline-notice" role="status">
          {connection === "reconnecting" ? "Reconnecting" : "Not connected"}; displayed facts may be stale.
        </p>
      ) : null}
      {historyError ? <p className="timeline-notice" role="alert">{historyError}</p> : null}
      {refreshError ? (
        <div className="timeline-notice" role="alert">
          <p>{refreshError}</p>
          <button type="button" disabled={refreshing} onClick={onRefresh}>Retry live activity</button>
        </div>
      ) : null}
      <div className="timeline-viewport" ref={viewport} role="region"
        aria-label="Live Agent Timeline" tabIndex={0}
        onScroll={() => {
          const region = viewport.current!;
          setFollow(region.scrollHeight - region.clientHeight - region.scrollTop <= 24);
          rememberAnchor();
        }}>
        <ol ref={content} className="timeline-items">
          {items.map((item) => (
            <li key={item.id} data-timeline-id={item.id} className={`timeline-item timeline-${item.tone}`}>
              <div className="timeline-item-heading">
                <strong>{item.title}</strong>
                {item.state ? <span className="timeline-state">{item.state}</span> : null}
              </div>
              <div className="timeline-metadata">
                <span>{item.source}</span>
                <span>{item.label}</span>
                <time dateTime={item.timestamp}>{item.timestamp}</time>
                {item.kind ? <span>{item.kind}</span> : null}
              </div>
              {item.body !== null ? <p className="timeline-text">{item.body}</p> : null}
              <details>
                <summary>Source details</summary>
                {item.provenance.map((value, index) => <p key={index}>{value}</p>)}
              </details>
            </li>
          ))}
        </ol>
        {!projection.activity.items.length ? <p className="compact-empty">No visible Run activity yet.</p> : null}
      </div>
    </section>
  );
}
