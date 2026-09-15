import { getCampaigns } from './api';
import type { CampaignListItem } from './types';

const POLL_MS = 3000;

/** Polls the campaign list while the picker is up; returns a disposer. */
export function watchCampaigns(onList: (list: CampaignListItem[]) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    getCampaigns(true)
      .then((list) => {
        if (!stopped) onList(list);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, POLL_MS);
      });
  };

  tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** The DM just made the first story: open it. Any other change leaves the picker up. */
export function autoPickId(shown: CampaignListItem[], next: CampaignListItem[]): number | null {
  const before = live(shown);
  const after = live(next);
  return before.length === 0 && after.length === 1 ? after[0].id : null;
}

const live = (list: CampaignListItem[]): CampaignListItem[] => list.filter((campaign) => !campaign.deleted_at);
