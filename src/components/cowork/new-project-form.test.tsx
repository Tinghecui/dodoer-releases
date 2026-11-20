import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/cowork/info", () => ({
  coworkCreateProject: vi.fn(),
  isProjectExistsError: () => false,
  validateProjectName: () => null,
}))

import { CoworkNewProjectForm } from "./new-project-form"

// #1110：项目名就是目录名，macOS 不能替用户把首字母改成大写、改拼写。
describe("CoworkNewProjectForm", () => {
  it("turns off autocapitalize and autocorrect on the project name", () => {
    render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <CoworkNewProjectForm
          projectsRoot="/home/demo/work"
          onCreated={() => {}}
        />
      </NextIntlClientProvider>
    )
    const input = screen.getByRole("textbox")
    expect(input).toHaveAttribute("autocapitalize", "off")
    expect(input).toHaveAttribute("autocorrect", "off")
    expect(input).toHaveAttribute("spellcheck", "false")
    expect(input).toHaveAttribute("autocomplete", "off")
  })
})
