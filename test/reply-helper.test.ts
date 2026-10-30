import { describe, expect, it } from 'vitest';
import { replyData, replyText } from './helpers/reply.js';

const NAG = '\n\nReminder: call checkpoint {op: save}.';
const data = { a: 1, nested: { b: [2, 3] } };
const json = JSON.stringify(data);

describe('reply helper', () => {
  it('prefers structuredContent when present', () => {
    const result = { content: [{ type: 'text', text: 'rendered prose' }], structuredContent: data };
    expect(replyData(result)).toEqual(data);
    expect(replyText(result)).toBe('rendered prose');
  });

  it('parses the JSON text body when structuredContent is absent', () => {
    expect(replyData({ content: [{ type: 'text', text: json }] })).toEqual(data);
  });

  it('strips the appended checkpoint nag before parsing', () => {
    const result = { content: [{ type: 'text', text: json + NAG }] };
    expect(replyData(result)).toEqual(data);
    expect(replyText(result)).toBe(json + NAG);
  });

  it('strips any other appended note, such as a roll rule', () => {
    expect(replyData({ content: [{ type: 'text', text: `${json}\n\nHeroic Inspiration spent.` }] })).toEqual(data);
  });

  it('ignores the nag when structuredContent is present', () => {
    expect(replyData({ content: [{ type: 'text', text: 'x' + NAG }], structuredContent: data })).toEqual(data);
  });

  it('throws a clear error when the text is not JSON', () => {
    expect(() => replyData({ content: [{ type: 'text', text: 'Just prose.' }] })).toThrow(/not JSON: Just prose\./);
  });
});
