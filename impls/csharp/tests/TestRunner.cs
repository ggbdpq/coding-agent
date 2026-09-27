namespace ccode.tests;

/// <summary>
/// 手写轻量断言运行器：逐个跑断言方法，输出 通过/失败 计数，以失败数作退出码。
/// 零第三方依赖（不引 xunit/MSTest/NUnit）。
/// </summary>
internal static class Runner
{
    public static int Passed;
    public static int Failed;

    public static void Case(string name, Action body)
    {
        try
        {
            body();
            Passed++;
        }
        catch (Exception e)
        {
            Failed++;
            Console.WriteLine($"[失败] {name}\n  {e.Message}");
        }
    }
}

/// <summary>断言助手：失败即抛，由 Runner 记失败。</summary>
internal static class Check
{
    public static void True(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    public static void Eq<T>(T expected, T actual, string? label = null)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new Exception($"{label ?? "不相等"}：期望 <{expected}>，实际 <{actual}>");
    }

    public static void Contains(string expected, string actual, string? label = null)
    {
        if (!actual.Contains(expected, StringComparison.Ordinal))
            throw new Exception($"{label ?? "应包含"} {expected}；实际：{Trunc(actual)}");
    }

    public static void Throws<TException>(Action body, string? label = null)
        where TException : Exception
    {
        try
        {
            body();
        }
        catch (TException)
        {
            return;
        }
        throw new Exception($"{label ?? "应抛出"} {typeof(TException).Name}");
    }

    private static string Trunc(string s) => s.Length <= 400 ? s : s[..400] + "…";
}

internal static class TestProgram
{
    public static int Main()
    {
        EditTests.All();
        TrimTests.All();
        NetGuardTests.All();
        RegistryTests.All();
        EventTests.All();
        AtRefTests.All();
        ApprovalTests.All();
        CompactTests.All();
        DiffTests.All();
        PatchTests.All();
        PlanModeTests.All();
        Smoke.All();
        Console.WriteLine($"{Runner.Passed} 通过 / {Runner.Failed} 失败");
        return Runner.Failed;
    }
}
