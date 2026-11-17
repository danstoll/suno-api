import Link from "next/link";
import Image from "next/image";
import Logo from "./Logo";

const GITHUB_URL = "https://github.com/danstoll/suno-api";

const itemClass =
    "px-1.5 sm:px-2 py-2 lg:px-6 lg:py-3 min-h-11 whitespace-nowrap rounded-full flex justify-center items-center gap-1 " +
    "lg:hover:bg-accent duration-200 " +
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function Header() {
    return (
        <nav aria-label="Main" className="flex w-full justify-center py-4 items-center
        border-b border-suno-muted backdrop-blur-2xl font-mono text-sm px-3 sm:px-4 lg:px-0">
            <div className="max-w-3xl flex w-full items-center justify-between">
                <Link href="/"
                    className="font-medium text-base sm:text-xl text-primary whitespace-nowrap flex items-center gap-2 rounded-full
                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                    <Logo className="w-4 h-4" />
                    Suno API
                </Link>
                <div className="flex items-center justify-center gap-1 text-sm font-light text-primary/90">
                    <Link href="/" className={itemClass}>Get Started</Link>
                    <Link href="/docs" className={itemClass}>API Docs</Link>
                    <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={itemClass}>
                        <Image src="/github-mark.png" alt="" width={20} height={20} className="dark:invert" />
                        <span className="sr-only sm:not-sr-only">GitHub</span>
                    </a>
                </div>
            </div>
        </nav>
    );
}
