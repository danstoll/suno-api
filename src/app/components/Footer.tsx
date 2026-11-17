import Link from "next/link";
import Image from "next/image";

export default function Footer() {
    return (
        <footer className=" flex w-full justify-center py-4 items-center
        bg-primary text-primary-ink/60 backdrop-blur-2xl font-mono text-sm px-4 lg:px-0
      ">
            <p className="px-6 py-3 rounded-full flex justify-center items-center gap-2
             hover:text-primary-ink duration-200
                ">

            </p>
            <p className="px-6 py-3 rounded-full flex justify-center items-center gap-2
             hover:text-primary-ink duration-200
                ">
                <span>© 2024</span>
                <Link href="https://github.com/gcui-art/suno-api/"
                    className="rounded-full underline-offset-4 lg:hover:underline
                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-ink">
                    gcui-art/suno-api
                </Link>
            </p>
        </footer>
    );
}
