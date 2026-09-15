// One shared request: a help tooltip asking the glossary panel to open on a term.
const request = $state<{ term: string | null }>({ term: null });

export const glossaryRequest = request;

export function askGlossary(term: string): void {
  request.term = term;
}

export function clearGlossaryRequest(): void {
  request.term = null;
}
