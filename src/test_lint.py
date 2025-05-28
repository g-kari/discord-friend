def test_function(a, b, c):  # black will fix spacing
    """Test function with linting issues."""
    if a > 10:
        print("a is greater than 10")  # flake8 will find indentation issue
        return True
    else:
        return False


# unnecessary blank lines that black will fix


def another_function():
    return 42
