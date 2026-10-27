/** Shared routing context for standalone and Geppetto prompt hooks. */
module.exports =
  'Does this message change the agreed task requirements? For substantial changes, use $requirements-blast-radius and create or update the Requirements map; reuse a supplied map and handle tiny local changes directly.\n' +
  'Is this feedback on your work? Use $receive-work-feedback to check the requested outcome and supporting evidence before revising.\n' +
  'Was the user frustrated by something you did or omitted? If so, use $geppetto-learn to assess a concrete way to prevent recurrence.';
