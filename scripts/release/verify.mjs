import { verifyDirectory, requireSuccessfulJobs } from './integrity.mjs'

if (process.argv[2] === 'jobs') requireSuccessfulJobs(JSON.parse(process.env.REQUIRED_JOBS ?? '{}'))
else {
  const manifest = await verifyDirectory(process.argv[2], { tag: process.env.CANDIDATE_TAG, commit: process.env.CANDIDATE_SHA })
  console.log(`Verified ${manifest.tag} ${manifest.commit} ${manifest.image.reference}`)
}
