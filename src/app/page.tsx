import Section from "./components/Section";
import Markdown from 'react-markdown';


export default function Home() {

  const markdown = `
## About this fork

A maintained fork of [gcui-art/suno-api](https://github.com/gcui-art/suno-api),
an unofficial REST wrapper around Suno's internal API. It signs in as your own
Suno account with a browser session cookie. There is no official API key.

## Run it locally

\`\`\`bash
npm install
npm run dev -- -p 3060
\`\`\`

Set \`SUNO_COOKIE\` in \`.env\` first. Then check that it works:
\`http://localhost:3060/api/get_limit\` returns your credit balance.

## Links

- [Status page](/status)
- [API docs](/docs)
- [Fork repository](https://github.com/danstoll/suno-api)

## Credit and licence

Based on [gcui-art/suno-api](https://github.com/gcui-art/suno-api) by gcui-art.
Licensed under LGPL-3.0 or later. See the
[LICENSE](https://github.com/gcui-art/suno-api/blob/main/LICENSE).
`;

  return (
    <>
      <Section className="">
        <div className="flex flex-col m-auto py-20 text-center items-center justify-center gap-4 my-8
        lg:px-20 px-4
        bg-indigo-900/90 rounded-2xl border shadow-2xl hover:shadow-none duration-200">
          <span className=" px-5 py-1 text-xs font-light border rounded-full 
          border-white/20 uppercase text-white/50">
            Unofficial
          </span>
          <h1 className="font-bold text-7xl flex text-white/90">
            Suno AI API
          </h1>
          <p className="text-white/80 text-lg">
            This is a homelab fork that runs your own Suno AI API.
          </p>
        </div>

      </Section>
      <Section className="my-10">
        <article className="prose lg:prose-lg max-w-3xl">
          <Markdown>
            {markdown}
          </Markdown>
        </article>
      </Section>


    </>
  );
}
